import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  InternalServerErrorException,
  Optional,
  Inject,
} from '@nestjs/common';
import { ModuleRef, ContextIdFactory } from '@nestjs/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseService } from '../../core/supabase/supabase.service.js';
import { getRequestContext } from '../../core/supabase/symbols.js';
import type { RequestExecutionContext } from '../../core/interfaces/request-execution-context.interface.js';
import type { GetMemoriesQueryDto } from '../dto/get-memories-query.dto.js';
import type {
  MemoryRecord,
  PaginatedMemoryResult,
  DeleteMemoryResult,
} from '../interfaces/memory.interface.js';

/**
 * Canonical NestJS Memory Domain Service (N4).
 * Coordinates domain interactions with public.memory_entries under strict RLS and RequestContext tenancy.
 *
 * Security & Tenancy Invariants:
 * - Operates strictly under caller's request-scoped Supabase client with active PostgreSQL RLS.
 * - Does NOT use service_role, raw SQL, or global clients.
 * - Enforces server-authoritative workspace_id and user_id via RequestContext.
 * - Deletion is strictly logical (UPDATE memory_entries SET is_deleted = true). Physical DELETE is forbidden.
 * - Deterministic ordering by (created_at DESC, id DESC).
 */
@Injectable()
export class MemoryService {
  private readonly moduleRef?: ModuleRef;
  private readonly supabaseService?: SupabaseService;

  constructor(
    @Optional()
    @Inject(ModuleRef)
    moduleRef?: ModuleRef,
    @Optional()
    @Inject(SupabaseService)
    supabaseService?: SupabaseService,
  ) {
    this.moduleRef = moduleRef;
    this.supabaseService = supabaseService;
  }

  private async getClient(execContext: RequestExecutionContext): Promise<SupabaseClient> {
    if (this.supabaseService) {
      return this.supabaseService.getClient();
    }

    if (this.moduleRef) {
      const request = execContext.rawRequest;
      const contextId = ContextIdFactory.getByRequest(request);
      this.moduleRef.registerRequestByContextId(request, contextId);
      const scopedSupabase = await this.moduleRef.resolve(SupabaseService, contextId, { strict: false });
      if (!scopedSupabase) {
        throw new InternalServerErrorException('Database infrastructure unavailable');
      }
      return scopedSupabase.getClient();
    }

    throw new InternalServerErrorException('Supabase client provider not configured');
  }

  /**
   * Retrieves paginated non-deleted memory entries for the authenticated user/workspace.
   */
  async getMemories(
    workspaceId: string,
    query: GetMemoriesQueryDto,
    execContext: RequestExecutionContext,
  ): Promise<PaginatedMemoryResult> {
    const requestContext = getRequestContext(execContext.rawRequest);
    if (!requestContext || !requestContext.tenantScope) {
      throw new ForbiddenException('Forbidden: Unresolved security context');
    }

    if (requestContext.tenantScope.workspaceId !== workspaceId) {
      throw new ForbiddenException('Forbidden: Cross-workspace access denied');
    }

    const userId = requestContext.principal.userId;
    const client = await this.getClient(execContext);

    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const { data, error, count } = await client
      .from('memory_entries')
      .select(
        'id, workspace_id, user_id, visibility, memory_type, content, confidence, source_agent, reason, is_deleted, created_at, updated_at',
        { count: 'exact' },
      )
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      throw new InternalServerErrorException('Failed to retrieve memory entries');
    }

    const entries: MemoryRecord[] = (data || []).map((row: any) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      userId: row.user_id,
      visibility: row.visibility,
      memoryType: row.memory_type,
      content: row.content,
      confidence: row.confidence ?? 1.0,
      sourceAgent: row.source_agent,
      reason: row.reason,
      isDeleted: row.is_deleted,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    return {
      entries,
      total: count ?? entries.length,
      limit,
      offset,
    };
  }

  /**
   * Performs logical soft deletion (is_deleted = true) on a memory entry.
   * If the record does not exist or belongs to another user/workspace, returns 404 Not Found.
   */
  async deleteMemory(
    workspaceId: string,
    memoryId: string,
    execContext: RequestExecutionContext,
  ): Promise<DeleteMemoryResult> {
    const requestContext = getRequestContext(execContext.rawRequest);
    if (!requestContext || !requestContext.tenantScope) {
      throw new ForbiddenException('Forbidden: Unresolved security context');
    }

    if (requestContext.tenantScope.workspaceId !== workspaceId) {
      throw new ForbiddenException('Forbidden: Cross-workspace access denied');
    }

    const userId = requestContext.principal.userId;
    const client = await this.getClient(execContext);

    const { data, error } = await client
      .from('memory_entries')
      .update({
        is_deleted: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', memoryId)
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .eq('is_deleted', false)
      .select('id, is_deleted');

    if (error) {
      throw new InternalServerErrorException('Failed to soft delete memory entry');
    }

    if (!data || data.length === 0) {
      throw new NotFoundException('Memory record not found');
    }

    return {
      id: memoryId,
      isDeleted: true,
    };
  }
}

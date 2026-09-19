import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Optional,
  Inject,
} from '@nestjs/common';
import { ModuleRef, ContextIdFactory } from '@nestjs/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseService } from '../../core/supabase/supabase.service.js';
import type { RequestExecutionContext } from '../../core/interfaces/request-execution-context.interface.js';
import type { CreateWorkspaceDto } from '../dto/create-workspace.dto.js';
import type { WorkspaceResponse, WorkspaceBootstrapResponse } from '../dto/workspace-response.dto.js';

/**
 * Workspace Service:
 * Coordinates domain interactions with public.workspaces and public.bootstrap_workspace RPC.
 *
 * Security Invariants:
 * - Operates strictly under caller's request-scoped Supabase client with active PostgreSQL RLS.
 * - Does NOT use service_role, raw SQL connections, or global clients.
 * - Never trusts client-supplied organization_id, user_id, role, or permissions.
 * - public.bootstrap_workspace RPC owns atomic workspace + member + audit provisioning.
 */
@Injectable()
export class WorkspaceService {
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
   * Invokes the authoritative public.bootstrap_workspace(p_name text) RPC.
   * Atomically provisions workspace, initial org_admin membership, and audit log.
   */
  async bootstrapWorkspace(
    dto: CreateWorkspaceDto,
    execContext: RequestExecutionContext,
  ): Promise<WorkspaceBootstrapResponse> {
    const client = await this.getClient(execContext);
    const trimmedName = dto.name.trim();

    if (!trimmedName) {
      throw new BadRequestException('Workspace name must not be empty');
    }

    const { data: workspaceId, error } = await client.rpc('bootstrap_workspace', {
      p_name: trimmedName,
    });

    if (error) {
      const code = (error as { code?: string }).code;
      if (code === '42501') {
        throw new ForbiddenException(error.message || 'Forbidden: Insufficient privileges to bootstrap workspace');
      }
      if (code === '22023') {
        throw new BadRequestException(error.message || 'Invalid workspace parameter');
      }
      if (code === '23505') {
        throw new ConflictException(error.message || 'Workspace already exists');
      }
      throw error;
    }

    if (!workspaceId) {
      throw new InternalServerErrorException('Failed to resolve bootstrapped workspace identifier');
    }

    return { id: workspaceId as string };
  }

  /**
   * Retrieves workspace details by ID under PostgreSQL RLS and pre-flight membership guard.
   */
  async getWorkspace(
    workspaceId: string,
    execContext: RequestExecutionContext,
  ): Promise<WorkspaceResponse> {
    const client = await this.getClient(execContext);

    const { data, error } = await client
      .from('workspaces')
      .select('id, organization_id, name, description, retention_policy, created_at, updated_at')
      .eq('id', workspaceId)
      .single();

    if (error || !data) {
      throw new NotFoundException('Workspace not found');
    }

    return {
      id: data.id,
      organizationId: data.organization_id,
      name: data.name,
      description: data.description ?? null,
      retentionPolicy: data.retention_policy ?? 'standard',
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }
}

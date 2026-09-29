import {
  Controller,
  Get,
  Delete,
  Param,
  Query,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard.js';
import { WorkspaceMemberGuard } from '../../workspace/guards/workspace-member.guard.js';
import { PermissionsGuard } from '../../workspace/guards/permissions.guard.js';
import { RequirePermissions } from '../../workspace/decorators/require-permissions.decorator.js';
import { createRequestExecutionContext } from '../../core/interfaces/request-execution-context.interface.js';
import { MemoryService } from '../services/memory.service.js';
import { GetMemoriesQueryDto } from '../dto/get-memories-query.dto.js';
import type {
  GetMemoriesResponseDto,
  DeleteMemoryResponseDto,
} from '../dto/memory-response.dto.js';

/**
 * Canonical NestJS Memory Controller (N4).
 * Exposes guarded, validated REST APIs for conversational and organizational memory management (ADR-0004 §7.9).
 *
 * Route Invariants:
 * - GET    /v1/workspaces/:workspace_id/memory           -> Paginated listing of caller's memories (Requires 'memory:read')
 * - DELETE /v1/workspaces/:workspace_id/memory/:memory_id -> Logical soft-delete of a memory entry (Requires 'memory:write_self')
 *
 * Security Pipeline:
 * 1. JwtAuthGuard: Authenticates caller via JWT -> binds AuthenticatedPrincipal
 * 2. WorkspaceMemberGuard: Resolves workspace membership -> binds TenantScope (404 anti-enumeration)
 * 3. PermissionsGuard: Evaluates atomic capability permissions
 */
@Controller('v1/workspaces/:workspace_id/memory')
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, PermissionsGuard)
export class MemoryController {
  constructor(private readonly memoryService: MemoryService) {}

  /**
   * List paginated memory entries for the authenticated user and workspace.
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('memory:read')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  async listMemories(
    @Param('workspace_id', new ParseUUIDPipe({ version: '4' })) workspaceId: string,
    @Query() query: GetMemoriesQueryDto,
    @Req() req: Request,
  ): Promise<GetMemoriesResponseDto> {
    const execContext = createRequestExecutionContext(req);
    const result = await this.memoryService.getMemories(workspaceId, query, execContext);

    return {
      data: result.entries.map((e) => ({
        id: e.id,
        workspace_id: e.workspaceId,
        user_id: e.userId,
        visibility: e.visibility,
        memory_type: e.memoryType,
        content: e.content,
        confidence: e.confidence,
        source_agent: e.sourceAgent,
        reason: e.reason,
        created_at: e.createdAt,
        updated_at: e.updatedAt,
      })),
      meta: {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      },
    };
  }

  /**
   * Logically soft-deletes a specific memory entry owned by the authenticated caller.
   */
  @Delete(':memory_id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('memory:write_self')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  async deleteMemory(
    @Param('workspace_id', new ParseUUIDPipe({ version: '4' })) workspaceId: string,
    @Param('memory_id', new ParseUUIDPipe({ version: '4' })) memoryId: string,
    @Req() req: Request,
  ): Promise<DeleteMemoryResponseDto> {
    const execContext = createRequestExecutionContext(req);
    const result = await this.memoryService.deleteMemory(workspaceId, memoryId, execContext);

    return {
      data: {
        success: true,
        id: result.id,
        is_deleted: true,
      },
    };
  }
}

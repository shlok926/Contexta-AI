import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  Req,
  ValidationPipe,
  UsePipes,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard.js';
import { WorkspaceBootstrapGuard } from '../guards/workspace-bootstrap.guard.js';
import { WorkspaceMemberGuard } from '../guards/workspace-member.guard.js';
import { PermissionsGuard } from '../guards/permissions.guard.js';
import { RequirePermissions } from '../decorators/require-permissions.decorator.js';
import { WorkspaceService } from '../services/workspace.service.js';
import { CreateWorkspaceDto } from '../dto/create-workspace.dto.js';
import { createRequestExecutionContext } from '../../core/interfaces/request-execution-context.interface.js';
import type { WorkspaceResponse, WorkspaceBootstrapResponse } from '../dto/workspace-response.dto.js';

/**
 * Canonical NestJS Workspace Controller.
 * Exposes /v1/workspaces HTTP API endpoints under declarative guard composition.
 *
 * Route Invariants:
 * - POST /v1/workspaces: Gated by [JwtAuthGuard, WorkspaceBootstrapGuard]. Bypasses WorkspaceMemberGuard.
 * - GET /v1/workspaces/:workspace_id: Gated by [JwtAuthGuard, WorkspaceMemberGuard, PermissionsGuard]. Requires 'workspace:read'.
 * - Controller remains strictly a thin gateway delegating persistence to WorkspaceService.
 */
@Controller('v1/workspaces')
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  /**
   * Bootstrap a new workspace entity.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard, WorkspaceBootstrapGuard)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  async createWorkspace(
    @Body() dto: CreateWorkspaceDto,
    @Req() req: Request,
  ): Promise<WorkspaceBootstrapResponse> {
    const execContext = createRequestExecutionContext(req);
    return this.workspaceService.bootstrapWorkspace(dto, execContext);
  }

  /**
   * Retrieve workspace metadata by ID.
   */
  @Get(':workspace_id')
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, PermissionsGuard)
  @RequirePermissions('workspace:read')
  async getWorkspace(
    @Param('workspace_id') workspaceId: string,
    @Req() req: Request,
  ): Promise<WorkspaceResponse> {
    const execContext = createRequestExecutionContext(req);
    return this.workspaceService.getWorkspace(workspaceId, execContext);
  }
}

import { Module } from '@nestjs/common';
import { PermissionsGuard } from './guards/permissions.guard.js';
import { WorkspaceMemberGuard } from './guards/workspace-member.guard.js';
import { WorkspaceBootstrapGuard } from './guards/workspace-bootstrap.guard.js';
import { WorkspaceService } from './services/workspace.service.js';
import { WorkspaceController } from './controllers/workspace.controller.js';
import { IdentityModule } from '../identity/identity.module.js';
import { CoreModule } from '../core/core.module.js';

@Module({
  imports: [IdentityModule, CoreModule],
  controllers: [WorkspaceController],
  providers: [WorkspaceService, PermissionsGuard, WorkspaceMemberGuard, WorkspaceBootstrapGuard],
  exports: [WorkspaceService, PermissionsGuard, WorkspaceMemberGuard, WorkspaceBootstrapGuard],
})
export class WorkspaceModule {}




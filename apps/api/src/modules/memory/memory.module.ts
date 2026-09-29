import { Module } from '@nestjs/common';
import { CoreModule } from '../core/core.module.js';
import { WorkspaceModule } from '../workspace/workspace.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { MemoryController } from './controllers/memory.controller.js';
import { MemoryService } from './services/memory.service.js';

/**
 * Canonical NestJS Memory Domain Module (N4).
 * Encapsulates memory management controllers, services, and RequestContext scoping.
 */
@Module({
  imports: [CoreModule, WorkspaceModule, IdentityModule],
  controllers: [MemoryController],
  providers: [MemoryService],
  exports: [MemoryService],
})
export class MemoryModule {}

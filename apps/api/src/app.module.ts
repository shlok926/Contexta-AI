import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CoreModule } from './modules/core/core.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { WorkspaceModule } from './modules/workspace/workspace.module.js';
import { AgentRuntimeModule } from './modules/agents/agent-runtime.module.js';
import { MemoryModule } from './modules/memory/memory.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    CoreModule,
    HealthModule,
    IdentityModule,
    WorkspaceModule,
    AgentRuntimeModule,
    MemoryModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}

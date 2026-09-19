import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { CoreModule } from './modules/core/core.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { WorkspaceModule } from './modules/workspace/workspace.module.js';
import { AgentRuntimeModule } from './modules/agents/agent-runtime.module.js';
import { MemoryModule } from './modules/memory/memory.module.js';
import { validateAuthConfig } from './modules/core/config/auth-config.schema.js';
import { CorrelationIdMiddleware } from './modules/core/middleware/correlation-id.middleware.js';
import { HttpExceptionFilter } from './modules/core/filters/http-exception.filter.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateAuthConfig,
    }),
    CoreModule,
    HealthModule,
    IdentityModule,
    WorkspaceModule,
    AgentRuntimeModule,
    MemoryModule,
  ],
  controllers: [],
  providers: [
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}


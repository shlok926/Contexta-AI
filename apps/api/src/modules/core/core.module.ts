import { Module } from '@nestjs/common';
import { CoreService } from './core.service.js';
import { SupabaseModule } from './supabase/supabase.module.js';
import { HttpExceptionFilter } from './filters/http-exception.filter.js';
import { CorrelationIdMiddleware } from './middleware/correlation-id.middleware.js';

@Module({
  imports: [SupabaseModule],
  controllers: [],
  providers: [CoreService, HttpExceptionFilter, CorrelationIdMiddleware],
  exports: [CoreService, SupabaseModule, HttpExceptionFilter, CorrelationIdMiddleware],
})
export class CoreModule {}


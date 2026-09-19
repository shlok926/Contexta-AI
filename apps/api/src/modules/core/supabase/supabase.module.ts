import { Module } from '@nestjs/common';
import { SupabaseService } from './supabase.service.js';

@Module({
  providers: [SupabaseService],
  exports: [SupabaseService],
})
export class SupabaseModule {}

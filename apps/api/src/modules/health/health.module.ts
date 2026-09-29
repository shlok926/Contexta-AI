import { Module } from '@nestjs/common';
import { HealthController } from './controllers/health.controller.js';

@Module({
  imports: [],
  controllers: [HealthController],
  providers: [],
  exports: [],
})
export class HealthModule {}

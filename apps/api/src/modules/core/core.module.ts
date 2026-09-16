import { Module } from '@nestjs/common';
import { CoreService } from './core.service.js';

@Module({
  imports: [],
  controllers: [],
  providers: [CoreService],
  exports: [CoreService],
})
export class CoreModule {}

import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';

export interface HealthCheckResponse {
  status: 'ok';
  timestamp: string;
}

@Controller('v1/health')
export class HealthController {
  @Get()
  @HttpCode(HttpStatus.OK)
  check(): HealthCheckResponse {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }
}

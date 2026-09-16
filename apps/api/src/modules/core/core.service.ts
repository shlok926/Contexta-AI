import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CoreService {
  constructor(private readonly configService: ConfigService) {
    // If metadata is preserved, this will be defined and DI succeeds.
    // If stripped, NestJS will throw 'Nest can't resolve dependencies of the CoreService (?).'
  }

  isConfigValid(): boolean {
    return !!this.configService;
  }
}

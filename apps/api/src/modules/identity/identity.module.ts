import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseModule } from '../core/supabase/supabase.module.js';
import { JWT_VERIFICATION_STRATEGY } from './strategies/jwt-verification.strategy.js';
import { SymmetricJwtStrategy } from './strategies/symmetric-jwt.strategy.js';
import { AsymmetricJwksStrategy } from './strategies/asymmetric-jwks.strategy.js';
import { IdentityService } from './services/identity.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import type { AuthConfig } from '../core/config/auth-config.schema.js';

@Module({
  imports: [SupabaseModule],
  controllers: [],
  providers: [
    IdentityService,
    JwtAuthGuard,
    {
      provide: JWT_VERIFICATION_STRATEGY,
      useFactory: (configService: ConfigService<AuthConfig>) => {
        const profile =
          configService.get<string>('JWT_VERIFICATION_PROFILE') ||
          configService.get<string>('JWT_VERIFICATION_STRATEGY') ||
          'symmetric';

        if (profile === 'asymmetric') {
          return new AsymmetricJwksStrategy(configService);
        }
        return new SymmetricJwtStrategy(configService);
      },
      inject: [ConfigService],
    },
  ],
  exports: [IdentityService, JwtAuthGuard, JWT_VERIFICATION_STRATEGY],
})
export class IdentityModule {}

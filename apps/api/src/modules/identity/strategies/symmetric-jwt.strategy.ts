import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { jwtVerify, errors } from 'jose';
import type { JwtClaims, JwtVerificationStrategy } from './jwt-verification.strategy.js';
import type { AuthConfig } from '../../core/config/auth-config.schema.js';

/**
 * Symmetric JWT verification strategy utilizing HMAC-SHA256 (HS256) via maintained jose library.
 * Designed for local development and Docker deployments.
 */
@Injectable()
export class SymmetricJwtStrategy implements JwtVerificationStrategy {
  private readonly secretKey: Uint8Array;
  private readonly expectedIssuer?: string;
  private readonly expectedAudience?: string;

  constructor(private readonly configService: ConfigService<AuthConfig>) {
    const secret = this.configService.get<string>('SUPABASE_JWT_SECRET');
    if (!secret || secret.trim().length < 32) {
      throw new Error('SymmetricJwtStrategy requires SUPABASE_JWT_SECRET (min 32 characters)');
    }
    this.secretKey = new TextEncoder().encode(secret);
    this.expectedIssuer = this.configService.get<string>('SUPABASE_JWT_ISSUER');
    this.expectedAudience = this.configService.get<string>('SUPABASE_JWT_AUDIENCE') || 'authenticated';
  }

  async verify(token: string): Promise<JwtClaims> {
    if (!token || typeof token !== 'string') {
      throw new UnauthorizedException('Authentication failed: Invalid or missing token');
    }

    try {
      const { payload } = await jwtVerify(token, this.secretKey, {
        algorithms: ['HS256'],
        issuer: this.expectedIssuer && this.expectedIssuer.trim().length > 0 ? this.expectedIssuer : undefined,
        audience: this.expectedAudience && this.expectedAudience.trim().length > 0 ? this.expectedAudience : undefined,
      });

      const sub = payload.sub;
      if (!sub || typeof sub !== 'string' || sub.trim().length === 0) {
        throw new UnauthorizedException('Authentication failed: Missing subject (sub) claim');
      }

      return {
        sub,
        email: typeof payload.email === 'string' ? payload.email : undefined,
        iss: typeof payload.iss === 'string' ? payload.iss : undefined,
        aud:
          Array.isArray(payload.aud) || typeof payload.aud === 'string'
            ? (payload.aud as string | string[])
            : undefined,
        exp: typeof payload.exp === 'number' ? payload.exp : undefined,
        nbf: typeof payload.nbf === 'number' ? payload.nbf : undefined,
        iat: typeof payload.iat === 'number' ? payload.iat : undefined,
        ...payload,
      };
    } catch (err: unknown) {
      if (err instanceof UnauthorizedException) {
        throw err;
      }
      if (err instanceof errors.JWTExpired) {
        throw new UnauthorizedException('Authentication failed: Token expired');
      }
      if (err instanceof errors.JWTClaimValidationFailed) {
        if (err.claim === 'nbf') {
          throw new UnauthorizedException('Authentication failed: Token not yet active');
        }
        if (err.claim === 'iss') {
          throw new UnauthorizedException('Authentication failed: Token issuer mismatch');
        }
        if (err.claim === 'aud') {
          throw new UnauthorizedException('Authentication failed: Token audience mismatch');
        }
        throw new UnauthorizedException(`Authentication failed: Invalid token claim (${err.claim})`);
      }
      if (err instanceof errors.JWSSignatureVerificationFailed) {
        throw new UnauthorizedException('Authentication failed: Invalid token signature');
      }
      if (err instanceof errors.JOSEAlgNotAllowed || err instanceof errors.JOSENotSupported) {
        throw new UnauthorizedException('Authentication failed: Unsupported or invalid JWT algorithm');
      }
      throw new UnauthorizedException('Authentication failed: Invalid token');
    }
  }
}

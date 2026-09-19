import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { jwtVerify, createRemoteJWKSet, importSPKI, errors, type JWTVerifyGetKey } from 'jose';
import type { JwtClaims, JwtVerificationStrategy } from './jwt-verification.strategy.js';
import type { AuthConfig } from '../../core/config/auth-config.schema.js';

/**
 * Asymmetric JWT verification strategy utilizing RS256 / ES256 and JWKS / Public Key via maintained jose library.
 * Designed for Supabase Cloud deployments.
 */
@Injectable()
export class AsymmetricJwksStrategy implements JwtVerificationStrategy {
  private readonly publicKey?: string;
  private readonly jwksUrl?: string;
  private readonly expectedIssuer?: string;
  private readonly expectedAudience?: string;
  private keyResolver?: JWTVerifyGetKey | unknown;

  constructor(private readonly configService: ConfigService<AuthConfig>) {
    this.publicKey = this.configService.get<string>('SUPABASE_JWT_PUBLIC_KEY');
    this.jwksUrl = this.configService.get<string>('SUPABASE_JWKS_URL');
    this.expectedIssuer = this.configService.get<string>('SUPABASE_JWT_ISSUER');
    this.expectedAudience = this.configService.get<string>('SUPABASE_JWT_AUDIENCE') || 'authenticated';

    if (!this.publicKey && !this.jwksUrl) {
      throw new Error('AsymmetricJwksStrategy requires either SUPABASE_JWT_PUBLIC_KEY or SUPABASE_JWKS_URL');
    }

    if (this.jwksUrl && this.jwksUrl.trim().length > 0) {
      this.keyResolver = createRemoteJWKSet(new URL(this.jwksUrl));
    }
  }

  async verify(token: string): Promise<JwtClaims> {
    if (!token || typeof token !== 'string') {
      throw new UnauthorizedException('Authentication failed: Invalid or missing token');
    }

    try {
      let keyOrResolver = this.keyResolver;
      if (!keyOrResolver && this.publicKey) {
        keyOrResolver = await importSPKI(this.publicKey, 'RS256');
        this.keyResolver = keyOrResolver;
      }

      if (!keyOrResolver) {
        throw new UnauthorizedException('Authentication failed: Cryptographic verification key not available');
      }

      const { payload } = await jwtVerify(token, keyOrResolver as any, {
        algorithms: ['RS256', 'ES256'],
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
        throw new UnauthorizedException('Authentication failed: Unsupported asymmetric algorithm');
      }
      throw new UnauthorizedException('Authentication failed: Invalid token');
    }
  }
}

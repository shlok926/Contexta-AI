import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import * as crypto from 'node:crypto';
import type { Request } from 'express';
import {
  JWT_VERIFICATION_STRATEGY,
  type JwtVerificationStrategy,
} from '../strategies/jwt-verification.strategy.js';
import { IdentityService } from '../services/identity.service.js';
import {
  bindVerifiedToken,
  bindRequestContext,
} from '../../core/supabase/symbols.js';
import { createRequestContext } from '../interfaces/request-context.interface.js';
import { createRequestExecutionContext } from '../../core/interfaces/request-execution-context.interface.js';
import type { AuthenticatedPrincipal } from '../interfaces/principal.interface.js';
import type { RequestMetadata } from '../interfaces/request-context.interface.js';

/**
 * Layer 1 Gateway Guard: Cryptographic JWT Authentication & Identity Resolution.
 *
 * Responsibilities:
 * 1. Extract Bearer token from incoming Authorization header.
 * 2. Cryptographically verify signature and claims using configured JwtVerificationStrategy.
 * 3. Privately bind the verified raw token to req[REQUEST_TOKEN_SYMBOL].
 * 4. Resolve and validate active user status via IdentityService.
 * 5. Construct and freeze immutable RequestContext at req[REQUEST_CONTEXT_SYMBOL].
 *
 * Security Invariant: Does NOT perform RBAC or tenancy permission checks (handled by Layer 2/3 guards).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(JWT_VERIFICATION_STRATEGY)
    private readonly jwtStrategy: JwtVerificationStrategy,
    private readonly identityService: IdentityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    if (!request) {
      throw new UnauthorizedException('Authentication failed: Invalid execution context');
    }

    // 1. Extract Bearer token
    const token = this.extractBearerToken(request);

    // 2. Cryptographically verify JWT claims
    const claims = await this.jwtStrategy.verify(token);

    // 3. Bind verified token privately to request (for downstream Supabase client)
    bindVerifiedToken(request, token);

    // 4. Resolve & validate active user identity
    const execContext = createRequestExecutionContext(request);
    const userProfile = await this.identityService.validateActiveUser(claims.sub, execContext);

    if (!userProfile || !userProfile.isActive) {
      throw new UnauthorizedException('Authentication failed: User account is inactive or not found');
    }

    if (!userProfile.organizationId) {
      throw new UnauthorizedException('Authentication failed: User record has no authoritative organization');
    }

    // 5. Construct & freeze immutable RequestContext
    const principal: AuthenticatedPrincipal = {
      userId: userProfile.userId,
      email: userProfile.email || (typeof claims.email === 'string' ? claims.email : ''),
      organizationId: userProfile.organizationId,
    };

    const correlationHeader = request.headers ? request.headers['x-correlation-id'] : undefined;
    const correlationId =
      typeof correlationHeader === 'string' && correlationHeader.trim().length > 0
        ? correlationHeader.trim()
        : crypto.randomUUID();

    const metadata: RequestMetadata = {
      correlationId,
      receivedAt: new Date(),
    };

    const requestContext = createRequestContext({
      principal,
      metadata,
    });

    // 6. Bind RequestContext to request
    bindRequestContext(request, requestContext);

    return true;
  }

  private extractBearerToken(request: Request): string {
    const headers = request.headers;
    if (!headers) {
      throw new UnauthorizedException('Authentication failed: Missing request headers');
    }

    const authHeader = headers['authorization'];
    if (!authHeader || typeof authHeader !== 'string') {
      throw new UnauthorizedException('Authentication failed: Missing Authorization header');
    }

    const trimmed = authHeader.trim();
    const scheme = trimmed.slice(0, 6).toLowerCase();
    const charAfter = trimmed.charAt(6);

    if (scheme !== 'bearer' || (charAfter !== '' && charAfter !== ' ' && charAfter !== '\t')) {
      throw new UnauthorizedException('Authentication failed: Authorization header must use Bearer scheme');
    }

    const token = trimmed.slice(6).trim();
    if (!token) {
      throw new UnauthorizedException('Authentication failed: Bearer token must not be empty');
    }

    return token;
  }
}

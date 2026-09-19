import * as crypto from 'node:crypto';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SymmetricJwtStrategy } from '../../src/modules/identity/strategies/symmetric-jwt.strategy.js';
import { AsymmetricJwksStrategy } from '../../src/modules/identity/strategies/asymmetric-jwks.strategy.js';
import {
  IdentityService,
  UserLookupProvider,
  USER_LOOKUP_PROVIDER,
  UserProfile,
} from '../../src/modules/identity/services/identity.service.js';
import { JwtAuthGuard } from '../../src/modules/identity/guards/jwt-auth.guard.js';
import {
  bindVerifiedToken,
  getVerifiedToken,
  getRequestContext,
  REQUEST_TOKEN_SYMBOL,
  REQUEST_CONTEXT_SYMBOL,
} from '../../src/modules/core/supabase/symbols.js';
import type { Request } from 'express';

describe('N2.3 JWT Verification & Identity Resolution', () => {
  const testSecret = 'test-secret-at-least-32-characters-long-key-12345';
  const testIssuer = 'https://auth.contexta.ai/v1';
  const testAudience = 'authenticated';

  // Generate RSA Key Pair for Asymmetric Tests
  const { publicKey: rsaPublicKey, privateKey: rsaPrivateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Helpers to create test JWT tokens
  function createTestJwt(
    payload: Record<string, unknown>,
    secretOrPrivateKey: string,
    options: {
      alg?: string;
      typ?: string;
      asymmetric?: boolean;
    } = {},
  ): string {
    const alg = options.alg ?? (options.asymmetric ? 'RS256' : 'HS256');
    const header = {
      alg,
      typ: options.typ ?? 'JWT',
    };

    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const data = `${headerB64}.${payloadB64}`;

    let signatureB64: string;
    if (alg === 'none') {
      signatureB64 = '';
    } else if (options.asymmetric) {
      const sign = crypto.createSign('RSA-SHA256');
      sign.update(data);
      signatureB64 = sign.sign(secretOrPrivateKey, 'base64url');
    } else {
      signatureB64 = crypto
        .createHmac('sha256', secretOrPrivateKey)
        .update(data)
        .digest('base64url');
    }

    return `${headerB64}.${payloadB64}.${signatureB64}`;
  }

  function mockConfigService(overrides: Record<string, unknown> = {}): ConfigService {
    const configMap: Record<string, unknown> = {
      SUPABASE_JWT_SECRET: testSecret,
      SUPABASE_JWT_PUBLIC_KEY: rsaPublicKey,
      SUPABASE_JWT_ISSUER: testIssuer,
      SUPABASE_JWT_AUDIENCE: testAudience,
      JWT_VERIFICATION_PROFILE: 'symmetric',
      ...overrides,
    };

    return {
      get: (key: string) => configMap[key],
    } as unknown as ConfigService;
  }

  function mockExecutionContext(req: Partial<Request>): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => req as Request,
        getResponse: () => ({}),
        getNext: () => ({}),
      }),
      getClass: () => ({}),
      getHandler: () => ({}),
      getArgs: () => [],
      getArgByIndex: () => ({}),
      switchToRpc: () => ({}),
      switchToWs: () => ({}),
      getType: () => 'http',
    } as unknown as ExecutionContext;
  }

  // ===========================================================================
  // A. Token Extraction Tests
  // ===========================================================================
  describe('A. Token Extraction in JwtAuthGuard', () => {
    let guard: JwtAuthGuard;
    let strategy: SymmetricJwtStrategy;
    let identityService: IdentityService;

    beforeEach(() => {
      const config = mockConfigService();
      strategy = new SymmetricJwtStrategy(config);
      const mockProvider: UserLookupProvider = {
        findUserById: async (id: string) => ({
          userId: id,
          email: 'test@contexta.ai',
          organizationId: 'org-123',
          isActive: true,
        }),
      };
      identityService = new IdentityService(mockProvider);
      guard = new JwtAuthGuard(strategy, identityService);
    });

    it('1. should reject request missing Authorization header', async () => {
      const context = mockExecutionContext({ headers: {} });
      await expect(guard.canActivate(context)).rejects.toThrow(
        /Missing Authorization header/,
      );
    });

    it('2. should reject malformed Authorization header without Bearer scheme', async () => {
      const context = mockExecutionContext({
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      });
      await expect(guard.canActivate(context)).rejects.toThrow(
        /Authorization header must use Bearer scheme/,
      );
    });

    it('3. should reject empty Bearer token', async () => {
      const context = mockExecutionContext({
        headers: { authorization: 'Bearer   ' },
      });
      await expect(guard.canActivate(context)).rejects.toThrow(
        /Bearer token must not be empty/,
      );
    });

    it('4. should accept valid Bearer format', async () => {
      const token = createTestJwt(
        {
          sub: 'user-valid-1',
          exp: Math.floor(Date.now() / 1000) + 3600,
          iss: testIssuer,
          aud: testAudience,
        },
        testSecret,
      );

      const req = { headers: { authorization: `Bearer ${token}` } };
      const context = mockExecutionContext(req);
      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(getVerifiedToken(req)).toBe(token);
    });

    it('5. should handle case-insensitive scheme and multiple whitespace', async () => {
      const token = createTestJwt(
        {
          sub: 'user-valid-2',
          exp: Math.floor(Date.now() / 1000) + 3600,
          iss: testIssuer,
          aud: testAudience,
        },
        testSecret,
      );

      const req = { headers: { authorization: `bearer   ${token}` } };
      const context = mockExecutionContext(req);
      const result = await guard.canActivate(context);

      expect(result).toBe(true);
    });
  });

  // ===========================================================================
  // B. Symmetric JWT Verification Strategy Tests
  // ===========================================================================
  describe('B. Symmetric JWT Verification Strategy', () => {
    let strategy: SymmetricJwtStrategy;

    beforeEach(() => {
      const config = mockConfigService();
      strategy = new SymmetricJwtStrategy(config);
    });

    it('6. should successfully verify a valid signed HS256 token', async () => {
      const token = createTestJwt(
        {
          sub: 'user-symmetric-1',
          email: 'user1@contexta.ai',
          exp: Math.floor(Date.now() / 1000) + 1800,
          iss: testIssuer,
          aud: testAudience,
        },
        testSecret,
      );

      const claims = await strategy.verify(token);
      expect(claims.sub).toBe('user-symmetric-1');
      expect(claims.email).toBe('user1@contexta.ai');
      expect(claims.iss).toBe(testIssuer);
      expect(claims.aud).toBe(testAudience);
    });

    it('7. should reject invalid signature signed with wrong secret', async () => {
      const token = createTestJwt(
        {
          sub: 'user-symmetric-1',
          exp: Math.floor(Date.now() / 1000) + 1800,
          iss: testIssuer,
          aud: testAudience,
        },
        'wrong-secret-at-least-32-characters-long-xxxx',
      );

      await expect(strategy.verify(token)).rejects.toThrow(/Invalid token signature/);
    });

    it('8. should reject token with tampered payload', async () => {
      const token = createTestJwt(
        {
          sub: 'legitimate-user',
          exp: Math.floor(Date.now() / 1000) + 1800,
          iss: testIssuer,
          aud: testAudience,
        },
        testSecret,
      );

      const [headerB64, , sigB64] = token.split('.');
      const tamperedPayloadB64 = Buffer.from(
        JSON.stringify({
          sub: 'attacker-user',
          exp: Math.floor(Date.now() / 1000) + 1800,
          iss: testIssuer,
          aud: testAudience,
        }),
      ).toString('base64url');

      const tamperedToken = `${headerB64}.${tamperedPayloadB64}.${sigB64}`;
      await expect(strategy.verify(tamperedToken)).rejects.toThrow(/Invalid token signature/);
    });

    it('9. should reject token with modified signature', async () => {
      const token = createTestJwt(
        {
          sub: 'user-1',
          exp: Math.floor(Date.now() / 1000) + 1800,
          iss: testIssuer,
          aud: testAudience,
        },
        testSecret,
      );

      const [header, payload, sig] = token.split('.');
      const modifiedSig = sig.slice(0, -2) + 'aa';
      const modifiedToken = `${header}.${payload}.${modifiedSig}`;

      await expect(strategy.verify(modifiedToken)).rejects.toThrow(/Invalid token signature/);
    });

    it('10. should reject expired token', async () => {
      const expiredToken = createTestJwt(
        {
          sub: 'user-expired',
          exp: Math.floor(Date.now() / 1000) - 60, // expired 1 minute ago
          iss: testIssuer,
          aud: testAudience,
        },
        testSecret,
      );

      await expect(strategy.verify(expiredToken)).rejects.toThrow(/Token expired/);
    });

    it('11. should reject token with future nbf (not yet active)', async () => {
      const futureToken = createTestJwt(
        {
          sub: 'user-future',
          nbf: Math.floor(Date.now() / 1000) + 300, // active in 5 minutes
          exp: Math.floor(Date.now() / 1000) + 3600,
          iss: testIssuer,
          aud: testAudience,
        },
        testSecret,
      );

      await expect(strategy.verify(futureToken)).rejects.toThrow(/Token not yet active/);
    });

    it('12. should reject unsupported algorithm (HS384, HS512)', async () => {
      const token = createTestJwt(
        {
          sub: 'user-algo',
          exp: Math.floor(Date.now() / 1000) + 1800,
        },
        testSecret,
        { alg: 'HS384' },
      );

      await expect(strategy.verify(token)).rejects.toThrow(
        /Unsupported or invalid JWT algorithm/,
      );
    });

    it('13. should reject algorithm confusion (RS256 token passed to symmetric strategy)', async () => {
      const token = createTestJwt(
        {
          sub: 'user-algo-confusion',
          exp: Math.floor(Date.now() / 1000) + 1800,
        },
        rsaPrivateKey,
        { asymmetric: true, alg: 'RS256' },
      );

      await expect(strategy.verify(token)).rejects.toThrow(
        /Unsupported or invalid JWT algorithm/,
      );
    });

    it('14. should reject unsigned token (alg: none)', async () => {
      const token = createTestJwt(
        {
          sub: 'user-none',
          exp: Math.floor(Date.now() / 1000) + 1800,
        },
        '',
        { alg: 'none' },
      );

      await expect(strategy.verify(token)).rejects.toThrow(
        /Unsupported or invalid JWT algorithm/,
      );
    });

    it('15. should fail closed when strategy lacks required secret at construction', () => {
      const invalidConfig = mockConfigService({ SUPABASE_JWT_SECRET: undefined });
      expect(() => new SymmetricJwtStrategy(invalidConfig)).toThrow(
        /SymmetricJwtStrategy requires SUPABASE_JWT_SECRET/,
      );
    });

    it('16. should reject token when issuer does not match configured issuer', async () => {
      const token = createTestJwt(
        {
          sub: 'user-iss-mismatch',
          exp: Math.floor(Date.now() / 1000) + 1800,
          iss: 'https://attacker-auth.com',
          aud: testAudience,
        },
        testSecret,
      );

      await expect(strategy.verify(token)).rejects.toThrow(/Token issuer mismatch/);
    });

    it('17. should reject token when audience does not match configured audience', async () => {
      const token = createTestJwt(
        {
          sub: 'user-aud-mismatch',
          exp: Math.floor(Date.now() / 1000) + 1800,
          iss: testIssuer,
          aud: 'unauthorized-audience',
        },
        testSecret,
      );

      await expect(strategy.verify(token)).rejects.toThrow(/Token audience mismatch/);
    });

    it('18. should accept array audience matching configured audience', async () => {
      const token = createTestJwt(
        {
          sub: 'user-aud-array',
          exp: Math.floor(Date.now() / 1000) + 1800,
          iss: testIssuer,
          aud: ['client-id', testAudience],
        },
        testSecret,
      );

      const claims = await strategy.verify(token);
      expect(claims.sub).toBe('user-aud-array');
    });
  });

  // ===========================================================================
  // C. Asymmetric JWT Verification Strategy Tests
  // ===========================================================================
  describe('C. Asymmetric JWT Verification Strategy', () => {
    let strategy: AsymmetricJwksStrategy;

    beforeEach(() => {
      const config = mockConfigService({
        JWT_VERIFICATION_PROFILE: 'asymmetric',
        SUPABASE_JWT_PUBLIC_KEY: rsaPublicKey,
      });
      strategy = new AsymmetricJwksStrategy(config);
    });

    it('19. should verify RS256 token signed with private key and verified with public key', async () => {
      const token = createTestJwt(
        {
          sub: 'user-asym-1',
          email: 'asym@contexta.ai',
          exp: Math.floor(Date.now() / 1000) + 3600,
          iss: testIssuer,
          aud: testAudience,
        },
        rsaPrivateKey,
        { asymmetric: true, alg: 'RS256' },
      );

      const claims = await strategy.verify(token);
      expect(claims.sub).toBe('user-asym-1');
      expect(claims.email).toBe('asym@contexta.ai');
    });

    it('20. should reject asymmetric token with modified payload or signature', async () => {
      const token = createTestJwt(
        {
          sub: 'user-asym-2',
          exp: Math.floor(Date.now() / 1000) + 3600,
          iss: testIssuer,
          aud: testAudience,
        },
        rsaPrivateKey,
        { asymmetric: true, alg: 'RS256' },
      );

      const [header, payload, sig] = token.split('.');
      const modifiedToken = `${header}.${payload}.${sig.slice(0, -4)}bbbb`;

      await expect(strategy.verify(modifiedToken)).rejects.toThrow(/Invalid token signature/);
    });

    it('21. should reject asymmetric strategy receiving HS256 symmetric token', async () => {
      const token = createTestJwt(
        {
          sub: 'user-asym-3',
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
        testSecret,
        { alg: 'HS256' },
      );

      await expect(strategy.verify(token)).rejects.toThrow(
        /Unsupported asymmetric algorithm/,
      );
    });
  });

  // ===========================================================================
  // D. Identity Resolution & Active User Validation Tests
  // ===========================================================================
  describe('D. Identity Resolution & Active User Validation', () => {
    it('23. should validate active user and return complete UserProfile', async () => {
      const mockProvider: UserLookupProvider = {
        findUserById: async (id: string) => ({
          userId: id,
          email: 'active@contexta.ai',
          organizationId: 'org-abc-123',
          isActive: true,
        }),
      };

      const identityService = new IdentityService(mockProvider);
      const profile = await identityService.validateActiveUser('user-active-1');

      expect(profile.userId).toBe('user-active-1');
      expect(profile.email).toBe('active@contexta.ai');
      expect(profile.organizationId).toBe('org-abc-123');
      expect(profile.isActive).toBe(true);
    });

    it('24. should reject unknown user not found in database', async () => {
      const mockProvider: UserLookupProvider = {
        findUserById: async () => null,
      };

      const identityService = new IdentityService(mockProvider);
      await expect(identityService.validateActiveUser('non-existent-user')).rejects.toThrow(
        /User account not found/,
      );
    });

    it('25. should reject inactive user (is_active = false)', async () => {
      const mockProvider: UserLookupProvider = {
        findUserById: async (id: string) => ({
          userId: id,
          email: 'deactivated@contexta.ai',
          organizationId: 'org-abc-123',
          isActive: false,
        }),
      };

      const identityService = new IdentityService(mockProvider);
      await expect(identityService.validateActiveUser('deactivated-user')).rejects.toThrow(
        /User account is inactive/,
      );
    });

    it('26. should reject malformed user record missing organizationId', async () => {
      const mockProvider: UserLookupProvider = {
        findUserById: async (id: string) => ({
          userId: id,
          email: 'no-org@contexta.ai',
          organizationId: '',
          isActive: true,
        }),
      };

      const identityService = new IdentityService(mockProvider);
      await expect(identityService.validateActiveUser('no-org-user')).rejects.toThrow(
        /User record has no organization/,
      );
    });
  });

  // ===========================================================================
  // E. RequestContext Construction & Token Privacy Tests
  // ===========================================================================
  describe('E. RequestContext Construction & Token Privacy in JwtAuthGuard', () => {
    let guard: JwtAuthGuard;
    const activeUserId = '00000000-0000-0000-0000-000000000001';
    const activeOrgId = '99999999-9999-9999-9999-999999999999';

    beforeEach(() => {
      const config = mockConfigService();
      const strategy = new SymmetricJwtStrategy(config);
      const mockProvider: UserLookupProvider = {
        findUserById: async (id: string) => {
          if (id === activeUserId) {
            return {
              userId: id,
              email: 'verified@contexta.ai',
              organizationId: activeOrgId,
              isActive: true,
            };
          }
          return null;
        },
      };
      const identityService = new IdentityService(mockProvider);
      guard = new JwtAuthGuard(strategy, identityService);
    });

    it('27. should derive userId from JWT sub and organizationId from database record', async () => {
      const token = createTestJwt(
        {
          sub: activeUserId,
          email: 'verified@contexta.ai',
          exp: Math.floor(Date.now() / 1000) + 3600,
          iss: testIssuer,
          aud: testAudience,
        },
        testSecret,
      );

      const req = { headers: { authorization: `Bearer ${token}` } };
      const context = mockExecutionContext(req);
      await guard.canActivate(context);

      const requestContext = getRequestContext(req);
      expect(requestContext).toBeDefined();
      expect(requestContext?.principal.userId).toBe(activeUserId);
      expect(requestContext?.principal.organizationId).toBe(activeOrgId);
      expect(requestContext?.principal.email).toBe('verified@contexta.ai');
    });

    it('28. should guarantee RequestContext contains ZERO raw tokens or credentials', async () => {
      const token = createTestJwt(
        {
          sub: activeUserId,
          exp: Math.floor(Date.now() / 1000) + 3600,
          iss: testIssuer,
          aud: testAudience,
        },
        testSecret,
      );

      const req = { headers: { authorization: `Bearer ${token}` } };
      const context = mockExecutionContext(req);
      await guard.canActivate(context);

      const requestContext = getRequestContext(req);
      expect(requestContext).toBeDefined();
      expect((requestContext as any).token).toBeUndefined();
      expect((requestContext as any).bearerToken).toBeUndefined();
      expect((requestContext as any).rawBearerToken).toBeUndefined();
      expect((requestContext?.principal as any).token).toBeUndefined();
    });

    it('29. should guarantee RequestContext is deeply frozen and immutable', async () => {
      const token = createTestJwt(
        {
          sub: activeUserId,
          exp: Math.floor(Date.now() / 1000) + 3600,
          iss: testIssuer,
          aud: testAudience,
        },
        testSecret,
      );

      const req = { headers: { authorization: `Bearer ${token}` } };
      const context = mockExecutionContext(req);
      await guard.canActivate(context);

      const requestContext = getRequestContext(req);
      expect(Object.isFrozen(requestContext)).toBe(true);
      expect(Object.isFrozen(requestContext?.principal)).toBe(true);
      expect(Object.isFrozen(requestContext?.metadata)).toBe(true);

      expect(() => {
        (requestContext?.principal as any).userId = 'hacked';
      }).toThrow(TypeError);
    });

    it('30. should bind verified token privately to REQUEST_TOKEN_SYMBOL without leaking in Object.keys or JSON', async () => {
      const token = createTestJwt(
        {
          sub: activeUserId,
          exp: Math.floor(Date.now() / 1000) + 3600,
          iss: testIssuer,
          aud: testAudience,
        },
        testSecret,
      );

      const req: Record<string | symbol, unknown> = {
        method: 'GET',
        url: '/v1/workspaces',
      };
      // Simulate auth header passed, verified, and bound
      bindVerifiedToken(req, token);

      // Bound token is accessible via symbol helper
      expect(getVerifiedToken(req)).toBe(token);

      // Symbol properties are NOT enumerable via Object.keys
      const keys = Object.keys(req);
      expect(keys).not.toContain('REQUEST_TOKEN_SYMBOL');
      expect(keys).not.toContain(token);
      expect(keys).toEqual(['method', 'url']);

      // JSON stringification of request object omits all symbol-keyed properties
      const jsonStr = JSON.stringify(req);
      expect(jsonStr).not.toContain(token);
      expect(jsonStr).not.toContain('REQUEST_TOKEN_SYMBOL');

      // RequestContext JSON serialization contains zero tokens or symbols
      const context = mockExecutionContext({ ...req, headers: { authorization: `Bearer ${token}` } });
      await guard.canActivate(context);
      const requestContext = getRequestContext(context.switchToHttp().getRequest());
      const rcJson = JSON.stringify(requestContext);
      expect(rcJson).not.toContain(token);
      expect(rcJson).not.toContain('REQUEST_TOKEN_SYMBOL');

      // Inaccessible via string indexing
      expect((req as any)['token']).toBeUndefined();
      expect((req as any)['REQUEST_TOKEN_SYMBOL']).toBeUndefined();
    });

    it('31. should never include secret values or raw tokens in thrown exception messages', async () => {
      const invalidToken = 'malformed.token.signature';
      const req = { headers: { authorization: `Bearer ${invalidToken}` } };
      const context = mockExecutionContext(req);

      try {
        await guard.canActivate(context);
        expect(true).toBe(false);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(UnauthorizedException);
        const msg = (err as Error).message;
        expect(msg).not.toContain(testSecret);
        expect(msg).not.toContain(invalidToken);
      }
    });
  });

  // ===========================================================================
  // F. Guard Request Isolation & Concurrency Tests
  // ===========================================================================
  describe('F. Guard Request Isolation Under Concurrency', () => {
    let guard: JwtAuthGuard;

    beforeEach(() => {
      const config = mockConfigService();
      const strategy = new SymmetricJwtStrategy(config);
      const mockProvider: UserLookupProvider = {
        findUserById: async (id: string) => ({
          userId: id,
          email: `${id}@contexta.ai`,
          organizationId: `org-for-${id}`,
          isActive: true,
        }),
      };
      const identityService = new IdentityService(mockProvider);
      guard = new JwtAuthGuard(strategy, identityService);
    });

    it('32. should maintain strict isolation between multiple concurrent distinct requests', async () => {
      const requests = Array.from({ length: 30 }, (_, i) => {
        const userId = `user-concurrency-${i}`;
        const token = createTestJwt(
          {
            sub: userId,
            exp: Math.floor(Date.now() / 1000) + 3600,
            iss: testIssuer,
            aud: testAudience,
          },
          testSecret,
        );

        return {
          req: {
            method: 'GET',
            headers: {
              authorization: `Bearer ${token}`,
              'x-correlation-id': `corr-${i}`,
            },
          } as unknown as Request,
          userId,
          token,
          orgId: `org-for-${userId}`,
        };
      });

      // Execute all guards concurrently
      await Promise.all(
        requests.map(async (r) => {
          const context = mockExecutionContext(r.req);
          const allowed = await guard.canActivate(context);
          expect(allowed).toBe(true);
        }),
      );

      // Verify each request holds strictly its own verified identity without cross-talk
      for (const r of requests) {
        const token = getVerifiedToken(r.req);
        const ctx = getRequestContext(r.req);

        expect(token).toBe(r.token);
        expect(ctx?.principal.userId).toBe(r.userId);
        expect(ctx?.principal.organizationId).toBe(r.orgId);
        expect(ctx?.metadata.correlationId).toBe(`corr-${r.userId.split('-')[2]}`);
      }
    });
  });
});

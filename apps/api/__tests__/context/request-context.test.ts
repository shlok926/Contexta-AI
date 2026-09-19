import {
  createRequestContext,
  RequestContext,
  TenantScope,
  AuthenticatedPrincipal,
  RequestMetadata,
} from '../../src/modules/identity/interfaces/request-context.interface.js';
import {
  createRequestExecutionContext,
  RequestExecutionContext,
} from '../../src/modules/core/interfaces/request-execution-context.interface.js';
import {
  REQUEST_TOKEN_SYMBOL,
  REQUEST_CONTEXT_SYMBOL,
  bindVerifiedToken,
  getVerifiedToken,
  bindRequestContext,
  getRequestContext,
} from '../../src/modules/core/supabase/symbols.js';
import {
  hasPermission,
  PermissionsMap,
} from '../../src/modules/workspace/interfaces/permissions.interface.js';
import type { Request } from 'express';

describe('N2.2 Request Execution Context & Immutability', () => {
  const samplePrincipal: AuthenticatedPrincipal = {
    userId: '11111111-1111-4111-a111-111111111111',
    email: 'user@contexta.ai',
    organizationId: '22222222-2222-4222-a222-222222222222',
  };

  const sampleMetadata: RequestMetadata = {
    correlationId: 'corr-uuid-12345',
    receivedAt: new Date('2026-09-18T10:00:00Z'),
  };

  const sampleTenantScope: TenantScope = {
    workspaceId: '33333333-3333-4333-a333-333333333333',
    organizationId: '22222222-2222-4222-a222-222222222222',
    role: 'contributor',
    permissions: Object.freeze({
      'workspace:read': true,
      'document:read': true,
      'document:upload': true,
    }),
  };

  describe('A. RequestContext Construction', () => {
    it('should construct a valid token-free RequestContext without tenant scope', () => {
      const ctx = createRequestContext({
        principal: samplePrincipal,
        metadata: sampleMetadata,
      });

      expect(ctx).toBeDefined();
      expect(ctx.principal.userId).toBe('11111111-1111-4111-a111-111111111111');
      expect(ctx.principal.email).toBe('user@contexta.ai');
      expect(ctx.principal.organizationId).toBe('22222222-2222-4222-a222-222222222222');
      expect(ctx.metadata.correlationId).toBe('corr-uuid-12345');
      expect(ctx.tenantScope).toBeUndefined();
      expect((ctx as any).token).toBeUndefined();
      expect((ctx as any).rawBearerToken).toBeUndefined();
    });

    it('should construct a valid RequestContext with tenant scope and permissions', () => {
      const ctx = createRequestContext({
        principal: samplePrincipal,
        tenantScope: sampleTenantScope,
        metadata: sampleMetadata,
      });

      expect(ctx.tenantScope).toBeDefined();
      expect(ctx.tenantScope?.workspaceId).toBe('33333333-3333-4333-a333-333333333333');
      expect(ctx.tenantScope?.role).toBe('contributor');
      expect(hasPermission(ctx.tenantScope?.permissions, 'document:read')).toBe(true);
      expect(hasPermission(ctx.tenantScope?.permissions, 'workspace:delete')).toBe(false);
    });
  });

  describe('B. Runtime Immutability', () => {
    it('should reject top-level property mutation on RequestContext', () => {
      const ctx = createRequestContext({
        principal: samplePrincipal,
        metadata: sampleMetadata,
      });

      expect(Object.isFrozen(ctx)).toBe(true);
      expect(() => {
        (ctx as any).principal = { userId: 'tampered-user' };
      }).toThrow(TypeError);
    });

    it('should reject mutation of AuthenticatedPrincipal properties', () => {
      const ctx = createRequestContext({
        principal: samplePrincipal,
        metadata: sampleMetadata,
      });

      expect(Object.isFrozen(ctx.principal)).toBe(true);
      expect(() => {
        (ctx.principal as any).userId = 'tampered-user-id';
      }).toThrow(TypeError);
      expect(() => {
        (ctx.principal as any).organizationId = 'tampered-org-id';
      }).toThrow(TypeError);
    });

    it('should reject mutation of TenantScope and permissions map', () => {
      const ctx = createRequestContext({
        principal: samplePrincipal,
        tenantScope: sampleTenantScope,
        metadata: sampleMetadata,
      });

      expect(Object.isFrozen(ctx.tenantScope)).toBe(true);
      expect(Object.isFrozen(ctx.tenantScope?.permissions)).toBe(true);

      expect(() => {
        (ctx.tenantScope as any).role = 'org_admin';
      }).toThrow(TypeError);

      expect(() => {
        (ctx.tenantScope?.permissions as any)['workspace:delete'] = true;
      }).toThrow(TypeError);
    });
  });

  describe('C. Request & Context Isolation', () => {
    it('should maintain strict isolation between concurrent distinct request contexts', async () => {
      const requests = Array.from({ length: 50 }, (_, i) => ({
        req: {} as unknown as Request,
        user: `user-${i}`,
        org: `org-${i}`,
        token: `jwt-token-for-user-${i}`,
      }));

      // Simulate concurrent requests initializing context
      await Promise.all(
        requests.map(async (r) => {
          const ctx = createRequestContext({
            principal: {
              userId: r.user,
              email: `${r.user}@contexta.ai`,
              organizationId: r.org,
            },
            metadata: {
              correlationId: `corr-${r.user}`,
              receivedAt: new Date(),
            },
          });

          bindVerifiedToken(r.req, r.token);
          bindRequestContext(r.req, ctx);
        })
      );

      // Verify each request holds only its own context and token without cross-talk
      for (const r of requests) {
        const boundToken = getVerifiedToken(r.req);
        const boundCtx = getRequestContext(r.req);

        expect(boundToken).toBe(r.token);
        expect(boundCtx?.principal.userId).toBe(r.user);
        expect(boundCtx?.principal.organizationId).toBe(r.org);
        expect(boundCtx?.metadata.correlationId).toBe(`corr-${r.user}`);
      }
    });
  });

  describe('D. Protected Context Lifecycle', () => {
    it('should bind context to request and retrieve it cleanly', () => {
      const mockReq = {} as Request;
      const ctx = createRequestContext({
        principal: samplePrincipal,
        metadata: sampleMetadata,
      });

      bindRequestContext(mockReq, ctx);
      const retrieved = getRequestContext(mockReq);

      expect(retrieved).toBe(ctx);
    });

    it('should fail closed when attempting to replace an existing RequestContext with a different instance', () => {
      const mockReq = {} as Request;
      const ctx1 = createRequestContext({
        principal: samplePrincipal,
        metadata: sampleMetadata,
      });
      const ctx2 = createRequestContext({
        principal: { ...samplePrincipal, userId: 'other-user' },
        metadata: sampleMetadata,
      });

      bindRequestContext(mockReq, ctx1);

      expect(() => {
        bindRequestContext(mockReq, ctx2);
      }).toThrow(/Cannot overwrite existing RequestContext on request/);

      // Initial context remains intact
      expect(getRequestContext(mockReq)?.principal.userId).toBe(samplePrincipal.userId);
    });

    it('should allow idempotent re-binding of the exact same context instance', () => {
      const mockReq = {} as Request;
      const ctx = createRequestContext({
        principal: samplePrincipal,
        metadata: sampleMetadata,
      });

      bindRequestContext(mockReq, ctx);
      expect(() => bindRequestContext(mockReq, ctx)).not.toThrow();
      expect(getRequestContext(mockReq)).toBe(ctx);
    });

    it('should fail closed when binding context to invalid request objects', () => {
      const ctx = createRequestContext({
        principal: samplePrincipal,
        metadata: sampleMetadata,
      });

      expect(() => bindRequestContext(null, ctx)).toThrow(/Invalid request object/);
      expect(() => bindRequestContext(undefined, ctx)).toThrow(/Invalid request object/);
      expect(() => bindRequestContext('string-target', ctx)).toThrow(/Invalid request object/);
    });
  });

  describe('E. Private Token Binding Security', () => {
    it('should bind and retrieve verified token through private symbol', () => {
      const mockReq = {} as Request;
      const verifiedToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.valid-token';

      bindVerifiedToken(mockReq, verifiedToken);
      expect(getVerifiedToken(mockReq)).toBe(verifiedToken);
    });

    it('should fail closed when attempting to overwrite an existing bound token with a different token', () => {
      const mockReq = {} as Request;
      bindVerifiedToken(mockReq, 'token-1');

      expect(() => {
        bindVerifiedToken(mockReq, 'token-2');
      }).toThrow(/Cannot overwrite existing verified token on request/);

      expect(getVerifiedToken(mockReq)).toBe('token-1');
    });

    it('should guarantee token is non-enumerable and not leaked in Object.keys or JSON serialization', () => {
      const mockReq = {
        method: 'POST',
        url: '/v1/workspaces',
        headers: { host: 'localhost:3000' },
      } as unknown as Request;

      const secretToken = 'TOP_SECRET_JWT_BEARER_TOKEN_VALUE';
      bindVerifiedToken(mockReq, secretToken);

      const keys = Object.keys(mockReq);
      expect(keys).not.toContain('REQUEST_TOKEN_SYMBOL');
      expect(keys).not.toContain(REQUEST_TOKEN_SYMBOL.toString());

      const json = JSON.stringify(mockReq);
      expect(json).not.toContain(secretToken);
      expect(json).not.toContain('REQUEST_TOKEN_SYMBOL');

      const propertyNames = Object.getOwnPropertyNames(mockReq);
      expect(propertyNames).not.toContain('REQUEST_TOKEN_SYMBOL');

      // Ordinary string lookup returns undefined
      expect((mockReq as any)['REQUEST_TOKEN_SYMBOL']).toBeUndefined();
      expect((mockReq as any)['token']).toBeUndefined();
    });

    it('should reject binding empty or non-string tokens', () => {
      const mockReq = {} as Request;

      expect(() => bindVerifiedToken(mockReq, '')).toThrow(/Cannot bind an empty or non-string token/);
      expect(() => bindVerifiedToken(mockReq, '   ')).toThrow(/Cannot bind an empty or non-string token/);
      expect(() => bindVerifiedToken(mockReq, null as any)).toThrow(/Cannot bind an empty or non-string token/);
    });
  });

  describe('F. Request Execution Context Handle', () => {
    it('should create an immutable RequestExecutionContext wrapping the raw request', () => {
      const mockReq = { method: 'GET', url: '/test' } as Request;
      const execContext: RequestExecutionContext = createRequestExecutionContext(mockReq);

      expect(execContext).toBeDefined();
      expect(execContext.rawRequest).toBe(mockReq);
      expect(Object.isFrozen(execContext)).toBe(true);

      expect(() => {
        (execContext as any).rawRequest = {} as Request;
      }).toThrow(TypeError);
    });
  });

  describe('G. Capability & Permission Evaluation Helpers', () => {
    it('should accurately evaluate permissions via hasPermission', () => {
      const permissions: PermissionsMap = Object.freeze({
        'workspace:read': true,
        'document:read': true,
        'run:execute': true,
      });

      expect(hasPermission(permissions, 'workspace:read')).toBe(true);
      expect(hasPermission(permissions, 'document:read')).toBe(true);
      expect(hasPermission(permissions, 'run:execute')).toBe(true);
      expect(hasPermission(permissions, 'workspace:delete')).toBe(false);
      expect(hasPermission(undefined, 'workspace:read')).toBe(false);
    });
  });
});

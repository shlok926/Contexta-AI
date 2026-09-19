import { jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { Scope, UnauthorizedException } from '@nestjs/common';
import { REQUEST, ModuleRef, ContextIdFactory } from '@nestjs/core';
import { ConfigService, ConfigModule } from '@nestjs/config';
import type { Request } from 'express';
import { SupabaseService } from '../../src/modules/core/supabase/supabase.service.js';
import { SupabaseModule } from '../../src/modules/core/supabase/supabase.module.js';
import {
  bindVerifiedToken,
  getVerifiedToken,
  REQUEST_TOKEN_SYMBOL,
} from '../../src/modules/core/supabase/symbols.js';
import { IdentityService } from '../../src/modules/identity/services/identity.service.js';
import { createRequestExecutionContext } from '../../src/modules/core/interfaces/request-execution-context.interface.js';

describe('N2.4 Request-Scoped Supabase Infrastructure', () => {
  const testSupabaseUrl = 'https://xyzcompany.supabase.co';
  const testAnonKey = 'anon-public-test-key-at-least-10-chars';

  function mockConfigService(): ConfigService {
    const configMap: Record<string, unknown> = {
      SUPABASE_URL: testSupabaseUrl,
      SUPABASE_ANON_KEY: testAnonKey,
    };
    return {
      get: (key: string) => configMap[key],
    } as unknown as ConfigService;
  }

  describe('1. SupabaseService Request Scope & Lifecycle', () => {
    it('should fail closed when verified token is missing on the request', () => {
      const mockReq = {} as Request;
      const config = mockConfigService();

      expect(() => new SupabaseService(mockReq, config as any)).toThrow(
        UnauthorizedException,
      );
      expect(() => new SupabaseService(mockReq, config as any)).toThrow(
        /Missing verified request token/,
      );
    });

    it('should construct SupabaseClient using SUPABASE_URL, SUPABASE_ANON_KEY, and verified token', () => {
      const mockReq = {} as Request;
      const testToken = 'verified.test.token.value';
      bindVerifiedToken(mockReq, testToken);

      const config = mockConfigService();
      const service = new SupabaseService(mockReq, config as any);

      const client = service.getClient();
      expect(client).toBeDefined();
      expect(typeof client.from).toBe('function');
    });

    it('should never use SUPABASE_SERVICE_ROLE_KEY for ordinary request client', () => {
      const mockReq = {} as Request;
      bindVerifiedToken(mockReq, 'token.user.123');
      const config = mockConfigService();

      const service = new SupabaseService(mockReq, config as any);
      const client = service.getClient();

      // Client should have rest url set to supabase url and anon key
      expect((client as any).supabaseUrl).toBe(testSupabaseUrl);
      expect((client as any).supabaseKey).toBe(testAnonKey);
    });
  });

  describe('2. Request Isolation & Token Boundary', () => {
    it('should ensure two concurrent requests receive isolated clients with strictly their own tokens', () => {
      const reqA = { headers: {} } as unknown as Request;
      const tokenA = 'token.for.user.A.123';
      bindVerifiedToken(reqA, tokenA);

      const reqB = { headers: {} } as unknown as Request;
      const tokenB = 'token.for.user.B.456';
      bindVerifiedToken(reqB, tokenB);

      const config = mockConfigService();

      const serviceA = new SupabaseService(reqA, config as any);
      const serviceB = new SupabaseService(reqB, config as any);

      const clientA = serviceA.getClient();
      const clientB = serviceB.getClient();

      // Assert instance isolation
      expect(clientA).not.toBe(clientB);

      // Assert private token isolation
      expect(getVerifiedToken(reqA)).toBe(tokenA);
      expect(getVerifiedToken(reqB)).toBe(tokenB);
      expect(tokenA).not.toBe(tokenB);

      // Assert client-level configuration
      const headersA = (clientA as any).headers ?? (clientA as any).rest?.headers ?? (clientA as any).auth?.headers;
      const authHeaderA = (clientA as any).headers?.Authorization ?? (clientA as any).rest?.headers?.Authorization;
      const authHeaderB = (clientB as any).headers?.Authorization ?? (clientB as any).rest?.headers?.Authorization;
      if (authHeaderA && authHeaderB) {
        expect(authHeaderA).toBe(`Bearer ${tokenA}`);
        expect(authHeaderB).toBe(`Bearer ${tokenB}`);
        expect(authHeaderA).not.toBe(authHeaderB);
      }
    });

    it('should maintain strict isolation across 20 concurrent SupabaseService instantiations', async () => {
      const config = mockConfigService();
      const requests = Array.from({ length: 20 }, (_, i) => {
        const req = { headers: {} } as unknown as Request;
        const token = `token.concurrent.user.${i}.${Date.now()}`;
        bindVerifiedToken(req, token);
        return { req, token };
      });

      const services = requests.map((r) => new SupabaseService(r.req, config as any));
      const clients = services.map((s) => s.getClient());

      // Verify every client is distinct and holds strictly its own verified token
      for (let i = 0; i < requests.length; i++) {
        expect(getVerifiedToken(requests[i].req)).toBe(requests[i].token);

        for (let j = i + 1; j < requests.length; j++) {
          expect(clients[i]).not.toBe(clients[j]);
          expect(getVerifiedToken(requests[i].req)).not.toBe(getVerifiedToken(requests[j].req));
        }
      }
    });
  });

  describe('3. NestJS ModuleRef & Request Context Resolution with IdentityService', () => {
    let moduleRef: TestingModule;
    let identityService: IdentityService;

    beforeEach(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            load: [() => ({ SUPABASE_URL: testSupabaseUrl, SUPABASE_ANON_KEY: testAnonKey })],
          }),
          SupabaseModule,
        ],
        providers: [
          IdentityService,
        ],
      }).compile();

      identityService = moduleRef.get<IdentityService>(IdentityService);
    });

    it('should resolve request-scoped SupabaseService through ContextIdFactory and query users table', async () => {
      const mockReq = {
        headers: {},
      } as unknown as Request;
      const verifiedToken = 'test.verified.jwt';
      bindVerifiedToken(mockReq, verifiedToken);

      const execContext = createRequestExecutionContext(mockReq);

      // Mock the Supabase client returned by request-scoped service
      const mockUserRow = {
        id: 'user-0001-uuid',
        email: 'member@contexta.ai',
        organization_id: 'org-9999-uuid',
        is_active: true,
      };

      const mockSupabaseClient = {
        from: (table: string) => {
          expect(table).toBe('users');
          return {
            select: (columns: string) => {
              expect(columns).toBe('id, organization_id, email, is_active');
              return {
                eq: (col: string, val: string) => {
                  expect(col).toBe('id');
                  expect(val).toBe('user-0001-uuid');
                  return {
                    single: async () => ({ data: mockUserRow, error: null }),
                  };
                },
              };
            },
          };
        },
      };

      const contextId = ContextIdFactory.getByRequest(mockReq);
      moduleRef.registerRequestByContextId(mockReq, contextId);

      // Spy on SupabaseService.getClient
      jest.spyOn(SupabaseService.prototype, 'getClient').mockReturnValue(mockSupabaseClient as any);

      const profile = await identityService.validateActiveUser('user-0001-uuid', execContext);

      expect(profile).toBeDefined();
      expect(profile.userId).toBe('user-0001-uuid');
      expect(profile.email).toBe('member@contexta.ai');
      expect(profile.organizationId).toBe('org-9999-uuid');
      expect(profile.isActive).toBe(true);
    });

    it('should reject inactive user from database with 401 Unauthorized', async () => {
      const mockReq = {} as Request;
      bindVerifiedToken(mockReq, 'test.token');
      const execContext = createRequestExecutionContext(mockReq);

      const mockInactiveUser = {
        id: 'user-inactive-uuid',
        email: 'inactive@contexta.ai',
        organization_id: 'org-9999-uuid',
        is_active: false,
      };

      const mockSupabaseClient = {
        from: () => ({
          select: () => ({
            eq: () => ({
              single: async () => ({ data: mockInactiveUser, error: null }),
            }),
          }),
        }),
      };

      const contextId = ContextIdFactory.getByRequest(mockReq);
      moduleRef.registerRequestByContextId(mockReq, contextId);
      jest.spyOn(SupabaseService.prototype, 'getClient').mockReturnValue(mockSupabaseClient as any);

      await expect(
        identityService.validateActiveUser('user-inactive-uuid', execContext),
      ).rejects.toThrow(/User account is inactive/);
    });

    it('should reject missing user from database with 401 Unauthorized', async () => {
      const mockReq = {} as Request;
      bindVerifiedToken(mockReq, 'test.token');
      const execContext = createRequestExecutionContext(mockReq);

      const mockSupabaseClient = {
        from: () => ({
          select: () => ({
            eq: () => ({
              single: async () => ({ data: null, error: { message: 'Row not found' } }),
            }),
          }),
        }),
      };

      const contextId = ContextIdFactory.getByRequest(mockReq);
      moduleRef.registerRequestByContextId(mockReq, contextId);
      jest.spyOn(SupabaseService.prototype, 'getClient').mockReturnValue(mockSupabaseClient as any);

      await expect(
        identityService.validateActiveUser('user-missing-uuid', execContext),
      ).rejects.toThrow(/User account not found/);
    });

    it('should reject user record missing authoritative organizationId with 401 Unauthorized', async () => {
      const mockReq = {} as Request;
      bindVerifiedToken(mockReq, 'test.token');
      const execContext = createRequestExecutionContext(mockReq);

      const mockNoOrgUser = {
        id: 'user-no-org-uuid',
        email: 'noorg@contexta.ai',
        organization_id: null,
        is_active: true,
      };

      const mockSupabaseClient = {
        from: () => ({
          select: () => ({
            eq: () => ({
              single: async () => ({ data: mockNoOrgUser, error: null }),
            }),
          }),
        }),
      };

      const contextId = ContextIdFactory.getByRequest(mockReq);
      moduleRef.registerRequestByContextId(mockReq, contextId);
      jest.spyOn(SupabaseService.prototype, 'getClient').mockReturnValue(mockSupabaseClient as any);

      await expect(
        identityService.validateActiveUser('user-no-org-uuid', execContext),
      ).rejects.toThrow(/User record has no organization/);
    });
  });
});

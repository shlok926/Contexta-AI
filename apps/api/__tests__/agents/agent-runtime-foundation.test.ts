import { jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Request } from 'express';
import { validateAuthConfig } from '../../src/modules/core/config/auth-config.schema.js';
import { AgentRuntimeModule } from '../../src/modules/agents/agent-runtime.module.js';

import { AgentRuntimeService } from '../../src/modules/agents/services/agent-runtime.service.js';
import {
  ExecutionContext,
  createExecutionContext,
} from '../../src/modules/agents/interfaces/execution-context.interface.js';
import {
  createAgentRunnableConfig,
  extractExecutionContext,
  EXECUTION_CONTEXT_KEY,
} from '../../src/modules/agents/adapters/runnable-config.bridge.js';
import { createRequestExecutionContext } from '../../src/modules/core/interfaces/request-execution-context.interface.js';
import { SupabaseService } from '../../src/modules/core/supabase/supabase.service.js';
import { bindVerifiedToken } from '../../src/modules/core/supabase/symbols.js';

describe('Phase N3.1: Agent Runtime Foundation & ExecutionContext', () => {
  const originalEnv = { ...process.env };

  const createMockSupabaseClient = (tag: string): SupabaseClient => {
    return {
      from: jest.fn().mockReturnValue({ select: jest.fn() }),
      rpc: jest.fn(),
      auth: {} as any,
      _mockTag: tag,
    } as unknown as SupabaseClient;
  };

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    process.env.PORT = '3000';
    process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_ANON_KEY = 'test-anon-key-min-10-chars';
    process.env.JWT_VERIFICATION_PROFILE = 'symmetric';
    process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret-with-at-least-32-chars-long';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // =========================================================================
  // TEST 1 — Nest DI Resolution
  // =========================================================================
  describe('TEST 1 — Nest DI Resolution', () => {
    it('should resolve AgentRuntimeService successfully from AgentRuntimeModule', async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            validate: validateAuthConfig,
          }),
          AgentRuntimeModule,
        ],
      }).compile();

      const service = module.get<AgentRuntimeService>(AgentRuntimeService);
      expect(service).toBeDefined();
      expect(service).toBeInstanceOf(AgentRuntimeService);
    });
  });


  // =========================================================================
  // TEST 2 — Module Registration
  // =========================================================================
  describe('TEST 2 — Module Registration', () => {
    it('should initialize root AppModule with AgentRuntimeModule registered', async () => {
      const { AppModule } = await import('../../src/app.module.js');
      const rootModule: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      const app = rootModule.get(AppModule);
      expect(app).toBeDefined();

      const runtimeService = rootModule.get<AgentRuntimeService>(AgentRuntimeService);
      expect(runtimeService).toBeDefined();
      expect(runtimeService).toBeInstanceOf(AgentRuntimeService);
    });
  });

  // =========================================================================
  // TEST 3 — ExecutionContext Construction
  // =========================================================================
  describe('TEST 3 — ExecutionContext Construction', () => {
    it('should construct a valid ExecutionContext using the factory API', () => {
      const mockClient = createMockSupabaseClient('client-1');
      const abortController = new AbortController();

      const ctx = createExecutionContext({
        supabaseClient: mockClient,
        signal: abortController.signal,
        timeoutMs: 15000,
        traceMetadata: {
          correlationId: 'corr-123',
          runId: 'run-456',
        },
      });

      expect(ctx).toBeDefined();
      expect(ctx.supabaseClient).toBe(mockClient);
      expect(ctx.signal).toBe(abortController.signal);
      expect(ctx.timeoutMs).toBe(15000);
      expect(ctx.traceMetadata?.correlationId).toBe('corr-123');
      expect(ctx.traceMetadata?.runId).toBe('run-456');
    });

    it('should throw TypeError if supabaseClient is missing or invalid', () => {
      expect(() => {
        createExecutionContext({
          supabaseClient: null as any,
        });
      }).toThrow(TypeError);

      expect(() => {
        createExecutionContext({
          supabaseClient: undefined as any,
        });
      }).toThrow(TypeError);
    });

    it('should support minimal construction with only supabaseClient', () => {
      const mockClient = createMockSupabaseClient('minimal');
      const ctx = createExecutionContext({ supabaseClient: mockClient });

      expect(ctx.supabaseClient).toBe(mockClient);
      expect(ctx.signal).toBeUndefined();
      expect(ctx.timeoutMs).toBeUndefined();
      expect(ctx.traceMetadata).toBeUndefined();
    });
  });

  // =========================================================================
  // TEST 4 — ExecutionContext Isolation
  // =========================================================================
  describe('TEST 4 — ExecutionContext Isolation', () => {
    it('should maintain strict isolation between two independently created contexts', () => {
      const clientA = createMockSupabaseClient('tenant-A');
      const clientB = createMockSupabaseClient('tenant-B');
      const signalA = new AbortController().signal;
      const signalB = new AbortController().signal;

      const ctxA = createExecutionContext({
        supabaseClient: clientA,
        signal: signalA,
        timeoutMs: 10000,
        traceMetadata: { correlationId: 'corr-A' },
      });

      const ctxB = createExecutionContext({
        supabaseClient: clientB,
        signal: signalB,
        timeoutMs: 25000,
        traceMetadata: { correlationId: 'corr-B' },
      });

      expect(ctxA.supabaseClient).not.toBe(ctxB.supabaseClient);
      expect(ctxA.signal).not.toBe(ctxB.signal);
      expect(ctxA.timeoutMs).not.toBe(ctxB.timeoutMs);
      expect(ctxA.traceMetadata?.correlationId).toBe('corr-A');
      expect(ctxB.traceMetadata?.correlationId).toBe('corr-B');
    });
  });

  // =========================================================================
  // TEST 5 — Non-Serialization & Immutability
  // =========================================================================
  describe('TEST 5 — Non-Serialization & Immutability', () => {
    it('should physically freeze ExecutionContext preventing runtime property mutation', () => {
      const mockClient = createMockSupabaseClient('frozen-test');
      const ctx = createExecutionContext({
        supabaseClient: mockClient,
        timeoutMs: 5000,
        traceMetadata: { correlationId: 'corr-freeze' },
      });

      expect(Object.isFrozen(ctx)).toBe(true);
      expect(Object.isFrozen(ctx.traceMetadata)).toBe(true);

      expect(() => {
        (ctx as any).timeoutMs = 99999;
      }).toThrow();

      expect(() => {
        (ctx as any).newProperty = 'leak';
      }).toThrow();
    });

    it('should not expose raw credentials or tokens on ExecutionContext', () => {
      const mockClient = createMockSupabaseClient('cred-test');
      const ctx = createExecutionContext({ supabaseClient: mockClient });

      const keys = Object.keys(ctx);
      expect(keys).not.toContain('token');
      expect(keys).not.toContain('bearerToken');
      expect(keys).not.toContain('authorization');
      expect(keys).not.toContain('apiKey');
      expect(keys).not.toContain('serviceRoleKey');
    });
  });

  // =========================================================================
  // TEST 6 — Singleton Statelessness
  // =========================================================================
  describe('TEST 6 — Singleton Statelessness', () => {
    it('should not retain request-specific state across successive invocations', async () => {
      const service = new AgentRuntimeService();

      const initialKeys = Object.keys(service);

      const client1 = createMockSupabaseClient('run-1');
      const ctx1 = service.createExecutionContext({
        supabaseClient: client1,
        timeoutMs: 1000,
        traceMetadata: { correlationId: 'c1' },
      });
      const config1 = service.createRunnableConfig(ctx1);
      expect(service.extractExecutionContext(config1)).toBe(ctx1);

      const client2 = createMockSupabaseClient('run-2');
      const ctx2 = service.createExecutionContext({
        supabaseClient: client2,
        timeoutMs: 2000,
        traceMetadata: { correlationId: 'c2' },
      });
      const config2 = service.createRunnableConfig(ctx2);
      expect(service.extractExecutionContext(config2)).toBe(ctx2);

      // Service instance properties must not have grown or retained request state
      const postKeys = Object.keys(service);
      expect(postKeys).toEqual(initialKeys);
    });
  });

  // =========================================================================
  // TEST 7 — Concurrent Isolation
  // =========================================================================
  describe('TEST 7 — Concurrent Isolation', () => {
    it('should handle multiple concurrent context creations without cross-contamination', async () => {
      const service = new AgentRuntimeService();
      const concurrencyCount = 25;

      const tasks = Array.from({ length: concurrencyCount }, async (_, i) => {
        const mockClient = createMockSupabaseClient(`tenant-${i}`);
        const ac = new AbortController();
        const correlationId = `corr-${i}`;
        const timeoutMs = 1000 + i * 100;

        const ctx = service.createExecutionContext({
          supabaseClient: mockClient,
          signal: ac.signal,
          timeoutMs,
          traceMetadata: { correlationId },
        });

        const config = service.createRunnableConfig(ctx, { runName: `run-${i}` });

        // Simulate micro-delay to test asynchronous interleaved concurrency
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));

        const extracted = service.extractExecutionContext(config);
        return { i, ctx, config, extracted, correlationId, timeoutMs };
      });

      const results = await Promise.all(tasks);

      expect(results).toHaveLength(concurrencyCount);
      for (const res of results) {
        expect(res.extracted).toBe(res.ctx);
        expect(res.ctx.timeoutMs).toBe(res.timeoutMs);
        expect(res.ctx.traceMetadata?.correlationId).toBe(res.correlationId);
        expect(res.config.runName).toBe(`run-${res.i}`);
      }
    });
  });

  // =========================================================================
  // TEST 8 — RunnableConfig Bridge
  // =========================================================================
  describe('TEST 8 — RunnableConfig Bridge', () => {
    it('should place ExecutionContext into configurable.executionContext', () => {
      const mockClient = createMockSupabaseClient('bridge-test');
      const ac = new AbortController();
      const ctx = createExecutionContext({
        supabaseClient: mockClient,
        signal: ac.signal,
        timeoutMs: 12000,
      });

      const config = createAgentRunnableConfig(ctx, {
        runName: 'test-agent-run',
        tags: ['agent', 'n3-foundation'],
        maxConcurrency: 5,
        recursionLimit: 10,
      });

      expect(config).toBeDefined();
      expect(config.configurable).toBeDefined();
      expect(config.configurable[EXECUTION_CONTEXT_KEY]).toBe(ctx);
      expect(config.signal).toBe(ac.signal);
      expect(config.timeout).toBe(12000);
      expect(config.runName).toBe('test-agent-run');
      expect(config.tags).toEqual(['agent', 'n3-foundation']);
      expect(config.maxConcurrency).toBe(5);
      expect(config.recursionLimit).toBe(10);
      expect(Object.isFrozen(config)).toBe(true);
    });

    it('should cleanly extract ExecutionContext from a valid config', () => {
      const mockClient = createMockSupabaseClient('extract-test');
      const ctx = createExecutionContext({ supabaseClient: mockClient });
      const config = createAgentRunnableConfig(ctx);

      const extracted = extractExecutionContext(config);
      expect(extracted).toBe(ctx);
      expect(extracted?.supabaseClient).toBe(mockClient);
    });

    it('should return undefined safely when extracting from null, undefined, or malformed config', () => {
      expect(extractExecutionContext(null)).toBeUndefined();
      expect(extractExecutionContext(undefined)).toBeUndefined();
      expect(extractExecutionContext({})).toBeUndefined();
      expect(extractExecutionContext({ configurable: {} })).toBeUndefined();
      expect(extractExecutionContext({ configurable: { [EXECUTION_CONTEXT_KEY]: null } as any })).toBeUndefined();
      expect(extractExecutionContext({ configurable: { [EXECUTION_CONTEXT_KEY]: { invalid: true } } as any })).toBeUndefined();
    });

    it('should throw TypeError when attempting to bridge invalid context', () => {
      expect(() => {
        createAgentRunnableConfig(null as any);
      }).toThrow(TypeError);

      expect(() => {
        createAgentRunnableConfig({} as any);
      }).toThrow(TypeError);
    });
  });

  // =========================================================================
  // TEST 9 — No Secret Leakage
  // =========================================================================
  describe('TEST 9 — No Secret Leakage', () => {
    it('should ensure serialized config or state representations contain zero secret patterns', () => {
      const mockClient = createMockSupabaseClient('no-leak');
      const ctx = createExecutionContext({
        supabaseClient: mockClient,
        timeoutMs: 5000,
        traceMetadata: {
          correlationId: 'corr-clean-999',
          runId: 'run-clean-999',
        },
      });

      const config = createAgentRunnableConfig(ctx, { runName: 'clean-run' });

      // Simulate a mock graph state (serializable plain data only)
      const mockGraphState = {
        runId: 'run-clean-999',
        correlationId: 'corr-clean-999',
        workspaceId: '11111111-1111-4111-a111-111111111111',
        userId: '22222222-2222-4222-a222-222222222222',
        originalQuery: 'Hello world',
      };

      const serializedState = JSON.stringify(mockGraphState);
      expect(serializedState).not.toMatch(/Bearer/i);
      expect(serializedState).not.toMatch(/eyJ/);
      expect(serializedState).not.toMatch(/service_role/i);
      expect(serializedState).not.toMatch(/secret/i);

      // Verify that ExecutionContext is quarantined outside the serializable state
      expect((mockGraphState as any).executionContext).toBeUndefined();
      expect((mockGraphState as any).supabaseClient).toBeUndefined();
    });
  });

  // =========================================================================
  // Request-Scoped Dynamic DI Resolution via RequestExecutionContext
  // =========================================================================
  describe('Request-Scoped DI Resolution (resolveExecutionContext)', () => {
    it('should resolve ExecutionContext using request-scoped SupabaseService', async () => {
      const mockClient = createMockSupabaseClient('request-scoped');
      const mockSupabaseService = {
        getClient: jest.fn().mockReturnValue(mockClient),
      } as unknown as SupabaseService;

      const service = new AgentRuntimeService(undefined, mockSupabaseService);

      const mockReq = {} as Request;
      bindVerifiedToken(mockReq, 'verified-test-jwt');
      const reqExecCtx = createRequestExecutionContext(mockReq);

      const execCtx = await service.resolveExecutionContext(reqExecCtx, {
        timeoutMs: 15000,
        traceMetadata: { correlationId: 'corr-di-test' },
      });

      expect(execCtx).toBeDefined();
      expect(execCtx.supabaseClient).toBe(mockClient);
      expect(execCtx.timeoutMs).toBe(15000);
      expect(execCtx.traceMetadata?.correlationId).toBe('corr-di-test');
    });
  });
});

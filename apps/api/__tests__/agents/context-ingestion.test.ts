import { createRequestContext } from '../../src/modules/identity/interfaces/request-context.interface.js';
import type { RequestContext } from '../../src/modules/identity/interfaces/request-context.interface.js';
import { WORKSPACE_ROLES } from '../../src/modules/workspace/interfaces/roles.interface.js';
import { ROLE_PERMISSIONS_MAP } from '../../src/modules/workspace/interfaces/permissions.interface.js';
import { AgentRuntimeService } from '../../src/modules/agents/services/agent-runtime.service.js';
import {
  ingestRequestContext,
  createInitialAgentStateFromRequestContext,
} from '../../src/modules/agents/adapters/context-ingestion.adapter.js';
import {
  SecurityException,
  validateProtectedContext,
  AgentStateSchema,
} from '../../../../packages/agents/src/state.js';
import { UnauthorizedException, ForbiddenException, BadRequestException } from '@nestjs/common';

describe('N3.3: RequestContext Ingestion & Credential Quarantine Boundary', () => {
  const TEST_USER_ID = '11111111-1111-4111-a111-111111111111';
  const TEST_ORG_ID = '22222222-2222-4222-a222-222222222222';
  const TEST_WORKSPACE_ID = '33333333-3333-4333-a333-333333333333';
  const TEST_THREAD_ID = '44444444-4444-4444-a444-444444444444';
  const TEST_CORRELATION_ID = '55555555-5555-4555-a555-555555555555';
  const TEST_RUN_ID = '66666666-6666-4666-a666-666666666666';

  let validRequestContext: RequestContext;
  let runtimeService: AgentRuntimeService;

  beforeEach(() => {
    validRequestContext = createRequestContext({
      principal: {
        userId: TEST_USER_ID,
        email: 'user@contexta.ai',
        organizationId: TEST_ORG_ID,
      },
      tenantScope: {
        workspaceId: TEST_WORKSPACE_ID,
        organizationId: TEST_ORG_ID,
        role: 'contributor',
        permissions: ROLE_PERMISSIONS_MAP.contributor,
      },
      metadata: {
        correlationId: TEST_CORRELATION_ID,
        receivedAt: new Date(),
      },
    });

    runtimeService = new AgentRuntimeService();
  });

  // ==========================================================================
  // UNIT TESTS: CONTEXT INGESTION & PROPAGATION (N3.3-UT-001 to N3.3-UT-007)
  // ==========================================================================
  describe('Unit Tests: Context Ingestion & Propagation', () => {
    it('N3.3-UT-001: Valid N2 RequestContext -> valid runtime protected context', () => {
      const protectedContext = ingestRequestContext(validRequestContext, {
        threadId: TEST_THREAD_ID,
        originalQuery: 'Hello world query',
      });

      expect(protectedContext).toBeDefined();
      expect(protectedContext.userId).toBe(TEST_USER_ID);
      expect(protectedContext.workspaceId).toBe(TEST_WORKSPACE_ID);
      expect(protectedContext.correlationId).toBe(TEST_CORRELATION_ID);
      expect(protectedContext.threadId).toBe(TEST_THREAD_ID);
      expect(protectedContext.originalQuery).toBe('Hello world query');
      expect(typeof protectedContext.runId).toBe('string');
      expect(protectedContext.runId.length).toBe(36);
    });

    it('N3.3-UT-002: Authenticated user identity is propagated correctly', () => {
      const state = createInitialAgentStateFromRequestContext(validRequestContext, {
        threadId: TEST_THREAD_ID,
        originalQuery: 'Verify user identity',
      });

      expect(state.userId).toBe(TEST_USER_ID);
    });

    it('N3.3-UT-003: Authorized workspace scope is propagated correctly', () => {
      const state = createInitialAgentStateFromRequestContext(validRequestContext, {
        threadId: TEST_THREAD_ID,
        originalQuery: 'Verify workspace scope',
      });

      expect(state.workspaceId).toBe(TEST_WORKSPACE_ID);
    });

    it('N3.3-UT-004: Thread identity is propagated from the trusted resource context', () => {
      const state = createInitialAgentStateFromRequestContext(validRequestContext, {
        threadId: TEST_THREAD_ID,
        originalQuery: 'Verify thread ID',
      });

      expect(state.threadId).toBe(TEST_THREAD_ID);
    });

    it('N3.3-UT-005: Original query is preserved exactly without alteration', () => {
      const rawQuery = '  Hello WORLD?  ';
      const state = createInitialAgentStateFromRequestContext(validRequestContext, {
        threadId: TEST_THREAD_ID,
        originalQuery: rawQuery,
      });

      expect(state.originalQuery).toBe(rawQuery);
      expect(state.originalQuery).not.toBe(rawQuery.trim());
      expect(state.originalQuery).not.toBe(rawQuery.toLowerCase());
      expect(state.normalizedQuery).toBe('');
    });

    it('N3.3-UT-006: Correlation ID is preserved from N2 metadata', () => {
      const state = createInitialAgentStateFromRequestContext(validRequestContext, {
        threadId: TEST_THREAD_ID,
        originalQuery: 'Verify correlation ID',
      });

      expect(state.correlationId).toBe(TEST_CORRELATION_ID);
    });

    it('N3.3-UT-007: Run ID is canonical UUIDv4 and no executionId is introduced', () => {
      const state = createInitialAgentStateFromRequestContext(validRequestContext, {
        threadId: TEST_THREAD_ID,
        originalQuery: 'Verify canonical runId',
        runId: TEST_RUN_ID,
      });

      expect(state.runId).toBe(TEST_RUN_ID);
      expect((state as unknown as Record<string, unknown>).executionId).toBeUndefined();
    });
  });

  // ==========================================================================
  // SECURITY CONTRACT TESTS (N3.3-SEC-001 to N3.3-SEC-011)
  // ==========================================================================
  describe('Security Contract Tests: Authorization & Quarantine Invariants', () => {
    it('N3.3-SEC-001: Client-supplied userId cannot override authenticated identity', () => {
      const untrustedPayload = {
        threadId: TEST_THREAD_ID,
        originalQuery: 'Query text',
        userId: '99999999-9999-4999-a999-999999999999',
      };

      const state = createInitialAgentStateFromRequestContext(
        validRequestContext,
        untrustedPayload as any
      );

      expect(state.userId).toBe(TEST_USER_ID);
      expect(state.userId).not.toBe(untrustedPayload.userId);
    });

    it('N3.3-SEC-002: Client-supplied workspaceId cannot override authorized tenant scope', () => {
      const untrustedPayload = {
        threadId: TEST_THREAD_ID,
        originalQuery: 'Query text',
        workspaceId: '88888888-8888-4888-a888-888888888888',
      };

      const state = createInitialAgentStateFromRequestContext(
        validRequestContext,
        untrustedPayload as any
      );

      expect(state.workspaceId).toBe(TEST_WORKSPACE_ID);
      expect(state.workspaceId).not.toBe(untrustedPayload.workspaceId);
    });

    it('N3.3-SEC-003: Client-supplied role cannot alter runtime identity', () => {
      const untrustedPayload = {
        threadId: TEST_THREAD_ID,
        originalQuery: 'Query text',
        role: 'org_admin',
      };

      const state = createInitialAgentStateFromRequestContext(
        validRequestContext,
        untrustedPayload as any
      );

      expect((state as unknown as Record<string, unknown>).role).toBeUndefined();
    });

    it('N3.3-SEC-004: Client-supplied permissions cannot alter runtime identity', () => {
      const untrustedPayload = {
        threadId: TEST_THREAD_ID,
        originalQuery: 'Query text',
        permissions: { 'org:admin': true },
      };

      const state = createInitialAgentStateFromRequestContext(
        validRequestContext,
        untrustedPayload as any
      );

      expect((state as unknown as Record<string, unknown>).permissions).toBeUndefined();
    });

    it('N3.3-SEC-005: Bearer token never appears in AgentState', () => {
      const state = createInitialAgentStateFromRequestContext(validRequestContext, {
        threadId: TEST_THREAD_ID,
        originalQuery: 'Query text',
      });

      expect((state as unknown as Record<string, unknown>).token).toBeUndefined();
      expect((state as unknown as Record<string, unknown>).bearerToken).toBeUndefined();
      expect((state as unknown as Record<string, unknown>).jwt).toBeUndefined();
    });

    it('N3.3-SEC-006: SupabaseClient never appears in AgentState', () => {
      const state = createInitialAgentStateFromRequestContext(validRequestContext, {
        threadId: TEST_THREAD_ID,
        originalQuery: 'Query text',
      });

      expect((state as unknown as Record<string, unknown>).supabaseClient).toBeUndefined();
      expect((state as unknown as Record<string, unknown>).client).toBeUndefined();
      expect((state as unknown as Record<string, unknown>).supabase).toBeUndefined();
    });

    it('N3.3-SEC-007: ExecutionContext never appears in AgentState', () => {
      const state = createInitialAgentStateFromRequestContext(validRequestContext, {
        threadId: TEST_THREAD_ID,
        originalQuery: 'Query text',
      });

      expect((state as unknown as Record<string, unknown>).executionContext).toBeUndefined();
      expect((state as unknown as Record<string, unknown>).context).toBeUndefined();
    });

    it('N3.3-SEC-008: Authorization header never appears in AgentState', () => {
      const state = createInitialAgentStateFromRequestContext(validRequestContext, {
        threadId: TEST_THREAD_ID,
        originalQuery: 'Query text',
      });

      expect((state as unknown as Record<string, unknown>).authorization).toBeUndefined();
      expect((state as unknown as Record<string, unknown>).authHeader).toBeUndefined();
      expect((state as unknown as Record<string, unknown>).headers).toBeUndefined();
    });

    it('N3.3-SEC-009: Protected context tampering causes SecurityException / fail-closed', () => {
      const state = createInitialAgentStateFromRequestContext(validRequestContext, {
        threadId: TEST_THREAD_ID,
        originalQuery: 'Query text',
      });

      // Attempt to tamper with protected fields
      expect(() => {
        validateProtectedContext(state, {
          workspaceId: '99999999-9999-4999-a999-999999999999',
        });
      }).toThrow(SecurityException);

      expect(() => {
        validateProtectedContext(state, {
          userId: '99999999-9999-4999-a999-999999999999',
        });
      }).toThrow(SecurityException);

      expect(() => {
        validateProtectedContext(state, {
          threadId: '99999999-9999-4999-a999-999999999999',
        });
      }).toThrow(SecurityException);

      expect(() => {
        validateProtectedContext(state, {
          runId: '99999999-9999-4999-a999-999999999999',
        });
      }).toThrow(SecurityException);

      expect(() => {
        validateProtectedContext(state, {
          correlationId: '99999999-9999-4999-a999-999999999999',
        });
      }).toThrow(SecurityException);

      expect(() => {
        validateProtectedContext(state, {
          originalQuery: 'tampered query',
        });
      }).toThrow(SecurityException);
    });

    it('N3.3-SEC-010: Clearing a protected field causes SecurityException rejection', () => {
      const state = createInitialAgentStateFromRequestContext(validRequestContext, {
        threadId: TEST_THREAD_ID,
        originalQuery: 'Query text',
      });

      expect(() => {
        validateProtectedContext(state, {
          workspaceId: '',
        });
      }).toThrow(SecurityException);

      expect(() => {
        validateProtectedContext(state, {
          userId: null as unknown as string,
        });
      }).toThrow(SecurityException);
    });

    it('N3.3-SEC-011: Same-value protected context propagation remains valid', () => {
      const state = createInitialAgentStateFromRequestContext(validRequestContext, {
        threadId: TEST_THREAD_ID,
        originalQuery: 'Query text',
      });

      expect(() => {
        validateProtectedContext(state, {
          workspaceId: TEST_WORKSPACE_ID,
          userId: TEST_USER_ID,
          threadId: TEST_THREAD_ID,
          originalQuery: 'Query text',
        });
      }).not.toThrow();
    });
  });

  // ==========================================================================
  // FAIL-CLOSED VALIDATION TESTS
  // ==========================================================================
  describe('Fail-Closed Invariants: Invalid or Missing Contexts', () => {
    it('should throw UnauthorizedException when RequestContext lacks principal', () => {
      const unauthenticatedContext = {
        metadata: { correlationId: TEST_CORRELATION_ID, receivedAt: new Date() },
      } as any;

      expect(() =>
        ingestRequestContext(unauthenticatedContext, {
          threadId: TEST_THREAD_ID,
          originalQuery: 'Query',
        })
      ).toThrow(UnauthorizedException);
    });

    it('should throw ForbiddenException when RequestContext lacks tenantScope', () => {
      const contextWithoutTenant = createRequestContext({
        principal: {
          userId: TEST_USER_ID,
          email: 'user@contexta.ai',
          organizationId: TEST_ORG_ID,
        },
        metadata: {
          correlationId: TEST_CORRELATION_ID,
          receivedAt: new Date(),
        },
      });

      expect(() =>
        ingestRequestContext(contextWithoutTenant, {
          threadId: TEST_THREAD_ID,
          originalQuery: 'Query',
        })
      ).toThrow(ForbiddenException);
    });

    it('should throw BadRequestException when threadId is malformed', () => {
      expect(() =>
        ingestRequestContext(validRequestContext, {
          threadId: 'invalid-thread-uuid',
          originalQuery: 'Query',
        })
      ).toThrow(BadRequestException);
    });

    it('should throw BadRequestException when originalQuery is empty', () => {
      expect(() =>
        ingestRequestContext(validRequestContext, {
          threadId: TEST_THREAD_ID,
          originalQuery: '',
        })
      ).toThrow(BadRequestException);
    });

    it('should throw BadRequestException when runId is malformed', () => {
      expect(() =>
        ingestRequestContext(validRequestContext, {
          threadId: TEST_THREAD_ID,
          originalQuery: 'Query',
          runId: 'not-a-uuid',
        })
      ).toThrow(BadRequestException);
    });
  });

  // ==========================================================================
  // CONCURRENCY & INTEGRATION TESTS
  // ==========================================================================
  describe('Concurrency & Integration (N3.3-CON-001, N3.3-CON-002, N3.3-INT-001, N3.3-INT-002)', () => {
    it('N3.3-CON-001: 20 concurrent runs maintain complete isolation', async () => {
      const concurrencyLoad = 20;
      const results = await Promise.all(
        Array.from({ length: concurrencyLoad }).map(async (_, idx) => {
          const userIdx = `00000000-0000-4000-a000-${String(idx).padStart(12, '0')}`;
          const wsIdx = `11111111-1111-4111-a111-${String(idx).padStart(12, '0')}`;
          const threadIdx = `22222222-2222-4222-a222-${String(idx).padStart(12, '0')}`;
          const corrIdx = `33333333-3333-4333-a333-${String(idx).padStart(12, '0')}`;

          const context = createRequestContext({
            principal: {
              userId: userIdx,
              email: `user${idx}@contexta.ai`,
              organizationId: TEST_ORG_ID,
            },
            tenantScope: {
              workspaceId: wsIdx,
              organizationId: TEST_ORG_ID,
              role: 'contributor',
              permissions: ROLE_PERMISSIONS_MAP.contributor,
            },
            metadata: {
              correlationId: corrIdx,
              receivedAt: new Date(),
            },
          });

          const state = runtimeService.createInitialState(context, {
            threadId: threadIdx,
            originalQuery: `Query from worker ${idx}`,
          });

          return { userIdx, wsIdx, threadIdx, corrIdx, state };
        })
      );

      // Verify each run received uniquely mapped state without collisions
      const userIds = new Set(results.map((r) => r.state.userId));
      const workspaceIds = new Set(results.map((r) => r.state.workspaceId));
      const threadIds = new Set(results.map((r) => r.state.threadId));
      const correlationIds = new Set(results.map((r) => r.state.correlationId));
      const runIds = new Set(results.map((r) => r.state.runId));

      expect(userIds.size).toBe(concurrencyLoad);
      expect(workspaceIds.size).toBe(concurrencyLoad);
      expect(threadIds.size).toBe(concurrencyLoad);
      expect(correlationIds.size).toBe(concurrencyLoad);
      expect(runIds.size).toBe(concurrencyLoad);
    });

    it('N3.3-CON-002: no singleton request-state leakage across invocations', () => {
      const stateA = runtimeService.createInitialState(validRequestContext, {
        threadId: TEST_THREAD_ID,
        originalQuery: 'Query A',
      });

      const secondContext = createRequestContext({
        principal: {
          userId: '99999999-9999-4999-a999-999999999999',
          email: 'other@contexta.ai',
          organizationId: TEST_ORG_ID,
        },
        tenantScope: {
          workspaceId: '88888888-8888-4888-a888-888888888888',
          organizationId: TEST_ORG_ID,
          role: 'viewer',
          permissions: ROLE_PERMISSIONS_MAP.viewer,
        },
        metadata: {
          correlationId: '77777777-7777-4777-a777-777777777777',
          receivedAt: new Date(),
        },
      });

      const stateB = runtimeService.createInitialState(secondContext, {
        threadId: '66666666-6666-4666-a666-666666666666',
        originalQuery: 'Query B',
      });

      expect(stateA.userId).toBe(TEST_USER_ID);
      expect(stateB.userId).toBe('99999999-9999-4999-a999-999999999999');
      expect(stateA.workspaceId).toBe(TEST_WORKSPACE_ID);
      expect(stateB.workspaceId).toBe('88888888-8888-4888-a888-888888888888');
    });

    it('N3.3-INT-001: N3.3 context integrates with AgentRuntimeService methods', () => {
      const protectedContext = runtimeService.ingestRequestContext(validRequestContext, {
        threadId: TEST_THREAD_ID,
        originalQuery: 'Query text',
      });

      expect(protectedContext).toBeDefined();
      expect(protectedContext.workspaceId).toBe(TEST_WORKSPACE_ID);

      const state = runtimeService.createInitialState(validRequestContext, {
        threadId: TEST_THREAD_ID,
        originalQuery: 'Query text',
      });

      expect(state).toBeDefined();
      expect(state.executionStatus).toBe('running');
    });

    it('N3.3-INT-002: resulting AgentState passes N3.2 canonical state validation', () => {
      const state = runtimeService.createInitialState(validRequestContext, {
        threadId: TEST_THREAD_ID,
        originalQuery: 'Query text',
      });

      const parsed = AgentStateSchema.safeParse(state);
      expect(parsed.success).toBe(true);
    });
  });

  // ==========================================================================
  // RUNTIME SERIALIZATION SECURITY SCAN
  // ==========================================================================
  describe('Runtime Serialization Security Scan', () => {
    it('should verify JSON.stringify(agentState) contains ZERO credentials, tokens, or runtime handles', () => {
      const state = runtimeService.createInitialState(validRequestContext, {
        threadId: TEST_THREAD_ID,
        originalQuery: 'Query text',
      });

      const serialized = JSON.stringify(state);

      // Verify zero forbidden secret patterns
      expect(serialized).not.toMatch(/Bearer/i);
      expect(serialized).not.toMatch(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/);
      expect(serialized).not.toMatch(/Authorization/i);
      expect(serialized).not.toMatch(/service_role/i);
      expect(serialized).not.toMatch(/api[_-]?key/i);
      expect(serialized).not.toMatch(/SupabaseClient/i);
      expect(serialized).not.toMatch(/ExecutionContext/i);
      expect(serialized).not.toMatch(/RequestExecutionContext/i);
    });
  });
});

import { jest } from '@jest/globals';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createRequestContext, type RequestContext } from '../../src/modules/identity/interfaces/request-context.interface.js';
import { ROLE_PERMISSIONS_MAP } from '../../src/modules/workspace/interfaces/permissions.interface.js';
import { AgentRunPersistenceService } from '../../src/modules/agents/services/agent-run-persistence.service.js';
import type { SupabaseService } from '../../src/modules/core/supabase/supabase.service.js';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('N3.4: Run Lifecycle & Database Persistence Service (Application / RPC Mock Suite)', () => {
  const TEST_USER_ID = '11111111-1111-4111-a111-111111111111';
  const TEST_ORG_ID = '22222222-2222-4222-a222-222222222222';
  const TEST_WORKSPACE_ID = '33333333-3333-4333-a333-333333333333';
  const TEST_THREAD_ID = '44444444-4444-4444-a444-444444444444';
  const TEST_CORRELATION_ID = '55555555-5555-4555-a555-555555555555';
  const TEST_RUN_ID = '66666666-6666-4666-a666-666666666666';

  let requestContext: RequestContext;
  let mockSupabaseClient: any;
  let mockSupabaseService: SupabaseService;
  let persistenceService: AgentRunPersistenceService;

  // In-memory mock database state
  let dbMessages: any[];
  let dbAgentRuns: any[];
  let dbAgentRunSteps: any[];

  beforeEach(() => {
    requestContext = createRequestContext({
      principal: {
        userId: TEST_USER_ID,
        email: 'developer@contexta.ai',
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

    dbMessages = [];
    dbAgentRuns = [];
    dbAgentRunSteps = [];

    mockSupabaseClient = {
      rpc: jest.fn((funcName: string, params: any) => {
        if (funcName === 'create_agent_run_turn') {
          const msgId = 'msg-' + Math.random().toString(36).substring(2, 9);
          const messageRow = {
            id: msgId,
            thread_id: params.p_thread_id,
            workspace_id: TEST_WORKSPACE_ID,
            user_id: TEST_USER_ID,
            role: 'user',
            content: params.p_query,
            citations: [],
            created_at: new Date().toISOString(),
          };
          dbMessages.push(messageRow);

          const runRow = {
            id: params.p_run_id,
            workspace_id: TEST_WORKSPACE_ID,
            thread_id: params.p_thread_id,
            initiating_message_id: msgId,
            assistant_message_id: null,
            user_id: TEST_USER_ID,
            correlation_id: params.p_correlation_id ?? TEST_CORRELATION_ID,
            query: params.p_query,
            status: 'accepted',
            verification_confidence_score: null,
            started_at: new Date().toISOString(),
            completed_at: null,
          };
          dbAgentRuns.push(runRow);
          return Promise.resolve({ data: [runRow], error: null });
        }

        if (funcName === 'transition_agent_run_status') {
          const run = dbAgentRuns.find((r) => r.id === params.p_run_id);
          if (!run) {
            return Promise.resolve({
              data: null,
              error: { code: '42501', message: 'FORBIDDEN_OR_NOT_FOUND: Run does not exist' },
            });
          }
          if (run.status !== params.p_from_status) {
            return Promise.resolve({
              data: null,
              error: {
                code: 'P0001',
                message: `CONFLICT: Expected run status ${params.p_from_status} but current is ${run.status}`,
              },
            });
          }
          run.status = params.p_to_status;
          if (['completed', 'declined_uncertain', 'failed', 'cancelled'].includes(params.p_to_status)) {
            run.completed_at = new Date().toISOString();
          }
          return Promise.resolve({ data: [run], error: null });
        }

        if (funcName === 'commit_agent_run_response') {
          const run = dbAgentRuns.find((r) => r.id === params.p_run_id);
          if (!run) {
            return Promise.resolve({
              data: null,
              error: { code: '42501', message: 'FORBIDDEN_OR_NOT_FOUND: Run does not exist' },
            });
          }
          if (['completed', 'declined_uncertain', 'failed', 'cancelled'].includes(run.status)) {
            return Promise.resolve({
              data: null,
              error: { code: 'P0001', message: `CONFLICT: Agent run is already in terminal state ${run.status}` },
            });
          }

          let assistantMsgId = null;
          if (['completed', 'declined_uncertain'].includes(params.p_status) && params.p_assistant_content) {
            assistantMsgId = 'asst-msg-' + Math.random().toString(36).substring(2, 9);
            dbMessages.push({
              id: assistantMsgId,
              thread_id: run.thread_id,
              workspace_id: run.workspace_id,
              user_id: null,
              role: 'assistant',
              content: params.p_assistant_content,
              citations: params.p_citations ?? [],
              created_at: new Date().toISOString(),
            });
          }

          run.status = params.p_status;
          run.assistant_message_id = assistantMsgId;
          run.verification_confidence_score = params.p_verification_score ?? null;
          run.completed_at = new Date().toISOString();

          return Promise.resolve({ data: [run], error: null });
        }

        throw new Error(`Unexpected RPC ${funcName}`);
      }),
      from: jest.fn((table: string) => {
        if (table === 'agent_runs') {
          return createAgentRunsTableQueryBuilder(dbAgentRuns);
        }
        if (table === 'agent_run_steps') {
          return createAgentRunStepsTableQueryBuilder(dbAgentRunSteps);
        }
        if (table === 'messages') {
          return createMessagesTableQueryBuilder(dbMessages);
        }
        throw new Error(`Unexpected table ${table}`);
      }),
    };

    mockSupabaseService = {
      getClient: jest.fn().mockReturnValue(mockSupabaseClient as unknown as SupabaseClient),
    } as unknown as SupabaseService;

    persistenceService = new AgentRunPersistenceService(undefined, mockSupabaseService);
  });

  function createMessagesTableQueryBuilder(storage: any[]) {
    return {
      insert: jest.fn((payload: any) => ({
        error: null,
        data: (() => {
          storage.push(payload);
          return payload;
        })(),
      })),
    };
  }

  function createAgentRunsTableQueryBuilder(storage: any[]) {
    return {
      select: jest.fn(() => ({
        eq: jest.fn((col1: string, val1: any) => ({
          eq: jest.fn((col2: string, val2: any) => ({
            maybeSingle: jest.fn(() => {
              const item = storage.find((r) => r[col1] === val1 && r[col2] === val2);
              return Promise.resolve({ data: item ?? null, error: null });
            }),
          })),
        })),
      })),
    };
  }

  function createAgentRunStepsTableQueryBuilder(storage: any[]) {
    return {
      insert: jest.fn((payload: any) => ({
        select: jest.fn(() => ({
          single: jest.fn(() => {
            storage.push(payload);
            return Promise.resolve({ data: payload, error: null });
          }),
        })),
      })),
      select: jest.fn(() => ({
        eq: jest.fn((col1: string, val1: any) => ({
          eq: jest.fn((col2: string, val2: any) => ({
            order: jest.fn((orderCol: string, { ascending }: { ascending: boolean }) => {
              const items = storage.filter((r) => r[col1] === val1 && r[col2] === val2);
              items.sort((a, b) => {
                const aVal = new Date(a[orderCol]).getTime();
                const bVal = new Date(b[orderCol]).getTime();
                return ascending ? aVal - bVal : bVal - aVal;
              });
              return Promise.resolve({ data: items, error: null });
            }),
          })),
        })),
      })),
    };
  }

  // ==========================================================================
  // A. RUN IDENTITY & ATOMIC TURN CREATION (RPC)
  // ==========================================================================
  describe('A. Run Identity & Database-Owned Atomic Turn Creation', () => {
    it('N3.4-RUN-001: atomically creates user message and agent_run via create_agent_run_turn RPC', async () => {
      const result = await persistenceService.createRun(requestContext, {
        threadId: TEST_THREAD_ID,
        query: 'What is the refund policy?',
        runId: TEST_RUN_ID,
      });

      expect(result.run.id).toBe(TEST_RUN_ID);
      expect(result.run.workspaceId).toBe(TEST_WORKSPACE_ID);
      expect(result.run.threadId).toBe(TEST_THREAD_ID);
      expect(result.run.userId).toBe(TEST_USER_ID);
      expect(result.run.status).toBe('accepted');
      expect(result.run.assistantMessageId).toBeNull();
      expect(result.initiatingMessageId).toBeDefined();

      // Verify RPC was invoked with exact parameters
      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith('create_agent_run_turn', {
        p_thread_id: TEST_THREAD_ID,
        p_query: 'What is the refund policy?',
        p_run_id: TEST_RUN_ID,
        p_correlation_id: TEST_CORRELATION_ID,
      });

      // Verify atomic state in mock DB
      expect(dbAgentRuns).toHaveLength(1);
      expect(dbAgentRuns[0].id).toBe(TEST_RUN_ID);
      expect(dbMessages).toHaveLength(1);
      expect(dbMessages[0].id).toBe(result.initiatingMessageId);
      expect(dbMessages[0].role).toBe('user');
    });

    it('N3.4-RUN-002: generates valid UUIDv4 runId when omitted', async () => {
      const result = await persistenceService.createRun(requestContext, {
        threadId: TEST_THREAD_ID,
        query: 'Architecture question',
      });

      expect(result.run.id).toBeDefined();
      expect(result.run.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('N3.4-RUN-003: rejects malformed runId with BadRequestException', async () => {
      await expect(
        persistenceService.createRun(requestContext, {
          threadId: TEST_THREAD_ID,
          query: 'Check invalid run ID',
          runId: 'not-a-uuid',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('N3.4-RUN-004: rejects malformed threadId with BadRequestException', async () => {
      await expect(
        persistenceService.createRun(requestContext, {
          threadId: 'bad-thread',
          query: 'Check invalid thread',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('N3.4-RUN-005: rejects empty query with BadRequestException', async () => {
      await expect(
        persistenceService.createRun(requestContext, {
          threadId: TEST_THREAD_ID,
          query: '   ',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ==========================================================================
  // B. LIFECYCLE STATE MACHINE TRANSITIONS (RPC + ROW LOCKING)
  // ==========================================================================
  describe('B. Lifecycle State Machine Transitions via RPC', () => {
    beforeEach(async () => {
      await persistenceService.createRun(requestContext, {
        threadId: TEST_THREAD_ID,
        query: 'Lifecycle testing query',
        runId: TEST_RUN_ID,
      });
    });

    it('N3.4-LIFE-001: transitions accepted -> running via transition_agent_run_status RPC', async () => {
      const updated = await persistenceService.transitionRunStatus(
        requestContext,
        TEST_RUN_ID,
        'accepted',
        'running',
      );

      expect(updated.status).toBe('running');
      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith('transition_agent_run_status', {
        p_run_id: TEST_RUN_ID,
        p_from_status: 'accepted',
        p_to_status: 'running',
      });
    });

    it('N3.4-LIFE-002: transitions running -> completed and sets completedAt', async () => {
      await persistenceService.transitionRunStatus(requestContext, TEST_RUN_ID, 'accepted', 'running');

      const completed = await persistenceService.transitionRunStatus(
        requestContext,
        TEST_RUN_ID,
        'running',
        'completed',
      );

      expect(completed.status).toBe('completed');
      expect(completed.completedAt).toBeInstanceOf(Date);
    });

    it('N3.4-LIFE-003: transitions running -> declined_uncertain and sets completedAt', async () => {
      await persistenceService.transitionRunStatus(requestContext, TEST_RUN_ID, 'accepted', 'running');

      const declined = await persistenceService.transitionRunStatus(
        requestContext,
        TEST_RUN_ID,
        'running',
        'declined_uncertain',
      );

      expect(declined.status).toBe('declined_uncertain');
      expect(declined.completedAt).toBeInstanceOf(Date);
    });

    it('N3.4-LIFE-004: transitions running -> failed and sets completedAt', async () => {
      await persistenceService.transitionRunStatus(requestContext, TEST_RUN_ID, 'accepted', 'running');

      const failed = await persistenceService.transitionRunStatus(
        requestContext,
        TEST_RUN_ID,
        'running',
        'failed',
      );

      expect(failed.status).toBe('failed');
      expect(failed.completedAt).toBeInstanceOf(Date);
    });

    it('N3.4-LIFE-005: transitions running -> cancelled and sets completedAt', async () => {
      await persistenceService.transitionRunStatus(requestContext, TEST_RUN_ID, 'accepted', 'running');

      const cancelled = await persistenceService.transitionRunStatus(
        requestContext,
        TEST_RUN_ID,
        'running',
        'cancelled',
      );

      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.completedAt).toBeInstanceOf(Date);
    });

    it('N3.4-LIFE-006: allows early failure/cancellation directly from accepted', async () => {
      const earlyFailed = await persistenceService.transitionRunStatus(
        requestContext,
        TEST_RUN_ID,
        'accepted',
        'failed',
      );

      expect(earlyFailed.status).toBe('failed');
    });

    it('N3.4-LIFE-007: strictly rejects illegal transitions out of terminal completed state', async () => {
      await persistenceService.transitionRunStatus(requestContext, TEST_RUN_ID, 'accepted', 'running');
      await persistenceService.transitionRunStatus(requestContext, TEST_RUN_ID, 'running', 'completed');

      await expect(
        persistenceService.transitionRunStatus(requestContext, TEST_RUN_ID, 'completed', 'running'),
      ).rejects.toThrow(ConflictException);
    });

    it('N3.4-LIFE-008: strictly rejects backward transitions (running -> accepted)', async () => {
      await persistenceService.transitionRunStatus(requestContext, TEST_RUN_ID, 'accepted', 'running');

      await expect(
        persistenceService.transitionRunStatus(requestContext, TEST_RUN_ID, 'running', 'accepted'),
      ).rejects.toThrow(ConflictException);
    });

    it('N3.4-LIFE-009: detects concurrent state mismatch from RPC and throws ConflictException', async () => {
      // In DB, status is 'accepted'. Trying to transition from 'running' fails in RPC
      await expect(
        persistenceService.transitionRunStatus(requestContext, TEST_RUN_ID, 'running', 'completed'),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ==========================================================================
  // C. TERMINAL STATE & ASSISTANT MESSAGE SEMANTICS (ATOMIC RPC)
  // ==========================================================================
  describe('C. Terminal State & Assistant Message Semantics via commit_agent_run_response RPC', () => {
    beforeEach(async () => {
      await persistenceService.createRun(requestContext, {
        threadId: TEST_THREAD_ID,
        query: 'Explain quantum computing',
        runId: TEST_RUN_ID,
      });
      await persistenceService.transitionRunStatus(requestContext, TEST_RUN_ID, 'accepted', 'running');
    });

    it('N3.4-TERM-001: completed run atomically persists assistant message and updates run', async () => {
      const finalized = await persistenceService.finalizeRun(requestContext, {
        runId: TEST_RUN_ID,
        status: 'completed',
        assistantMessage: {
          content: 'Quantum computing leverages qubits and superposition.',
          citations: [{ claimId: 'c1', evidenceId: 'e1' }],
        },
        verificationConfidenceScore: 0.98,
      });

      expect(finalized.status).toBe('completed');
      expect(finalized.assistantMessageId).toBeDefined();
      expect(finalized.verificationConfidenceScore).toBe(0.98);

      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith('commit_agent_run_response', {
        p_run_id: TEST_RUN_ID,
        p_status: 'completed',
        p_assistant_content: 'Quantum computing leverages qubits and superposition.',
        p_citations: [{ claimId: 'c1', evidenceId: 'e1' }],
        p_verification_score: 0.98,
      });

      const assistantMsg = dbMessages.find((m) => m.id === finalized.assistantMessageId);
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg.role).toBe('assistant');
      expect(assistantMsg.user_id).toBeNull();
    });

    it('N3.4-TERM-002: declined_uncertain run persists safe decline assistant message', async () => {
      const finalized = await persistenceService.finalizeRun(requestContext, {
        runId: TEST_RUN_ID,
        status: 'declined_uncertain',
        assistantMessage: {
          content: 'I cannot verify this answer with sufficient confidence from the provided documents.',
        },
        verificationConfidenceScore: 0.35,
      });

      expect(finalized.status).toBe('declined_uncertain');
      expect(finalized.assistantMessageId).toBeDefined();
      expect(finalized.verificationConfidenceScore).toBe(0.35);
    });

    it('N3.4-TERM-003: failed run NEVER commits assistant message', async () => {
      const finalized = await persistenceService.finalizeRun(requestContext, {
        runId: TEST_RUN_ID,
        status: 'failed',
      });

      expect(finalized.status).toBe('failed');
      expect(finalized.assistantMessageId).toBeNull();
      expect(dbMessages).toHaveLength(1);
    });

    it('N3.4-TERM-004: cancelled run NEVER commits assistant message', async () => {
      const finalized = await persistenceService.finalizeRun(requestContext, {
        runId: TEST_RUN_ID,
        status: 'cancelled',
      });

      expect(finalized.status).toBe('cancelled');
      expect(finalized.assistantMessageId).toBeNull();
      expect(dbMessages).toHaveLength(1);
    });

    it('N3.4-TERM-005: rejects attempting to attach assistant message to failed run', async () => {
      await expect(
        persistenceService.finalizeRun(requestContext, {
          runId: TEST_RUN_ID,
          status: 'failed',
          assistantMessage: {
            content: 'Fake partial assistant answer',
          },
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('N3.4-TERM-006: rejects attempting to finalize an already finalized run', async () => {
      await persistenceService.finalizeRun(requestContext, {
        runId: TEST_RUN_ID,
        status: 'completed',
        assistantMessage: { content: 'First answer' },
      });

      await expect(
        persistenceService.finalizeRun(requestContext, {
          runId: TEST_RUN_ID,
          status: 'completed',
          assistantMessage: { content: 'Duplicate answer' },
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('N3.4-TERM-007: rejects invalid verificationConfidenceScore outside [0, 1]', async () => {
      await expect(
        persistenceService.finalizeRun(requestContext, {
          runId: TEST_RUN_ID,
          status: 'completed',
          verificationConfidenceScore: 1.5,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ==========================================================================
  // D. AGENT RUN STEPS PERSISTENCE & TELEMETRY SANITIZATION (APPEND-ONLY)
  // ==========================================================================
  describe('D. Agent Run Steps Append-Only Audit & Telemetry Sanitization', () => {
    beforeEach(async () => {
      await persistenceService.createRun(requestContext, {
        threadId: TEST_THREAD_ID,
        query: 'Query for step tracing',
        runId: TEST_RUN_ID,
      });
      await persistenceService.transitionRunStatus(requestContext, TEST_RUN_ID, 'accepted', 'running');
    });

    it('N3.4-STEP-001: records execution step with valid allowlisted telemetry payload', async () => {
      const step = await persistenceService.recordStep(requestContext, {
        runId: TEST_RUN_ID,
        agentName: 'supervisor',
        nodeName: 'SupervisorNode',
        durationMs: 145,
        inputPayload: {
          nodeName: 'SupervisorNode',
          status: 'started',
          durationMs: 0,
        },
        outputPayload: {
          nodeName: 'SupervisorNode',
          status: 'completed',
          durationMs: 145,
          routeDecision: 'knowledge_query',
        },
      });

      expect(step.id).toBeDefined();
      expect(step.agentRunId).toBe(TEST_RUN_ID);
      expect(step.workspaceId).toBe(TEST_WORKSPACE_ID);
      expect(step.agentName).toBe('supervisor');
      expect(step.nodeName).toBe('SupervisorNode');
      expect(step.durationMs).toBe(145);
      expect(step.inputPayload).toEqual({
        nodeName: 'SupervisorNode',
        status: 'started',
        durationMs: 0,
      });
      expect(step.outputPayload).toEqual({
        nodeName: 'SupervisorNode',
        status: 'completed',
        durationMs: 145,
        routeDecision: 'knowledge_query',
      });
    });

    it('N3.4-STEP-002: strictly strips prohibited fields (prompts, tokens, completions) from payloads', async () => {
      const step = await persistenceService.recordStep(requestContext, {
        runId: TEST_RUN_ID,
        agentName: 'researcher',
        nodeName: 'ResearchNode',
        durationMs: 320,
        inputPayload: {
          nodeName: 'ResearchNode',
          status: 'started',
          durationMs: 0,
          rawPrompt: 'You are a secret AI with key sk-12345',
          bearerToken: 'eyJhbGciOi...',
        } as any,
        outputPayload: {
          nodeName: 'ResearchNode',
          status: 'completed',
          durationMs: 320,
          evidenceCount: 4,
          modelCompletion: 'Here is raw text from GPT-4',
          chainOfThought: 'Step 1: think, Step 2: verify',
        } as any,
      });

      expect(step.inputPayload).toEqual({
        nodeName: 'ResearchNode',
        status: 'started',
        durationMs: 0,
      });
      expect((step.inputPayload as any).rawPrompt).toBeUndefined();
      expect((step.inputPayload as any).bearerToken).toBeUndefined();

      expect(step.outputPayload).toEqual({
        nodeName: 'ResearchNode',
        status: 'completed',
        durationMs: 320,
        evidenceCount: 4,
      });
      expect((step.outputPayload as any).modelCompletion).toBeUndefined();
      expect((step.outputPayload as any).chainOfThought).toBeUndefined();
    });

    it('N3.4-STEP-003: rejects negative durationMs with BadRequestException', async () => {
      await expect(
        persistenceService.recordStep(requestContext, {
          runId: TEST_RUN_ID,
          agentName: 'researcher',
          nodeName: 'ResearchNode',
          durationMs: -50,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('N3.4-STEP-004: retrieves all steps in deterministic ascending chronological order', async () => {
      const step1 = await persistenceService.recordStep(requestContext, {
        runId: TEST_RUN_ID,
        agentName: 'supervisor',
        nodeName: 'SupervisorNode',
        durationMs: 50,
      });

      const step2 = await persistenceService.recordStep(requestContext, {
        runId: TEST_RUN_ID,
        agentName: 'researcher',
        nodeName: 'ResearchNode',
        durationMs: 200,
      });

      const step3 = await persistenceService.recordStep(requestContext, {
        runId: TEST_RUN_ID,
        agentName: 'verifier',
        nodeName: 'VerificationNode',
        durationMs: 150,
      });

      const steps = await persistenceService.getRunSteps(requestContext, TEST_RUN_ID);
      expect(steps).toHaveLength(3);
      expect(steps[0].id).toBe(step1.id);
      expect(steps[1].id).toBe(step2.id);
      expect(steps[2].id).toBe(step3.id);
    });
  });

  // ==========================================================================
  // E. TENANCY, SECURITY & BOUNDARY ENFORCEMENT
  // ==========================================================================
  describe('E. Tenancy, Security & Boundary Enforcement', () => {
    it('N3.4-SEC-001: rejects unauthenticated RequestContext missing userId', async () => {
      const invalidCtx = createRequestContext({
        principal: { userId: '', email: 'anon@test.com', organizationId: TEST_ORG_ID },
        tenantScope: {
          workspaceId: TEST_WORKSPACE_ID,
          organizationId: TEST_ORG_ID,
          role: 'viewer',
          permissions: ROLE_PERMISSIONS_MAP.viewer,
        },
        metadata: { correlationId: TEST_CORRELATION_ID, receivedAt: new Date() },
      });

      await expect(
        persistenceService.createRun(invalidCtx, {
          threadId: TEST_THREAD_ID,
          query: 'Test security',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('N3.4-SEC-002: rejects RequestContext missing authorized tenant workspace scope', async () => {
      const ctxWithoutTenant = createRequestContext({
        principal: { userId: TEST_USER_ID, email: 'user@test.com', organizationId: TEST_ORG_ID },
        metadata: { correlationId: TEST_CORRELATION_ID, receivedAt: new Date() },
      });

      await expect(
        persistenceService.createRun(ctxWithoutTenant, {
          threadId: TEST_THREAD_ID,
          query: 'Test missing tenant',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('N3.4-SEC-003: prevents cross-tenant run retrieval (returns 404 for foreign workspace)', async () => {
      await persistenceService.createRun(requestContext, {
        threadId: TEST_THREAD_ID,
        query: 'Private workspace run',
        runId: TEST_RUN_ID,
      });

      const foreignContext = createRequestContext({
        principal: { userId: TEST_USER_ID, email: 'user@test.com', organizationId: TEST_ORG_ID },
        tenantScope: {
          workspaceId: '99999999-9999-4999-a999-999999999999',
          organizationId: TEST_ORG_ID,
          role: 'viewer',
          permissions: ROLE_PERMISSIONS_MAP.viewer,
        },
        metadata: { correlationId: TEST_CORRELATION_ID, receivedAt: new Date() },
      });

      await expect(persistenceService.getRun(foreignContext, TEST_RUN_ID)).rejects.toThrow(NotFoundException);
    });

    it('N3.4-SEC-004: PostgREST RLS permission errors (42501) normalize to ForbiddenException', async () => {
      mockSupabaseClient.rpc = jest.fn(() =>
        Promise.resolve({
          data: null,
          error: { code: '42501', message: 'permission denied for RPC create_agent_run_turn' },
        }),
      );

      await expect(
        persistenceService.createRun(requestContext, {
          threadId: TEST_THREAD_ID,
          query: 'Test RLS rejection',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});

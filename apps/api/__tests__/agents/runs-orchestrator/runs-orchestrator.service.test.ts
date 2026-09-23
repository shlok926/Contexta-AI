import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  RunsOrchestratorService,
  type ExecuteRunParams,
} from '../../../src/modules/agents/services/runs-orchestrator.service.js';
import { AgentRuntimeService } from '../../../src/modules/agents/services/agent-runtime.service.js';
import { AgentRunPersistenceService } from '../../../src/modules/agents/services/agent-run-persistence.service.js';
import { RetrievalOrchestratorService } from '../../../src/modules/agents/services/retrieval-orchestrator.service.js';
import { createRequestContext } from '../../../src/modules/identity/interfaces/request-context.interface.js';
import type { RequestContext } from '../../../src/modules/identity/interfaces/request-context.interface.js';
import { ROLE_PERMISSIONS_MAP } from '../../../src/modules/workspace/interfaces/permissions.interface.js';
import { graph } from '../../../../../packages/agents/src/graph.js';
import type { AgentState } from '../../../../../packages/agents/src/state.js';
import type { IDraftGeneratorProvider } from '../../../../../packages/agents/src/draft-response/draft-generator.interface.js';
import type { IVerificationProvider } from '../../../../../packages/agents/src/citation-verification/verification-provider.interface.js';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

describe('N3.8-C7.2: RunsOrchestratorService (Application Execution Bridge)', () => {
  let orchestrator: RunsOrchestratorService;
  let mockRuntimeService: AgentRuntimeService;
  let mockPersistenceService: AgentRunPersistenceService;
  let mockRetrievalOrchestrator: RetrievalOrchestratorService;

  const TEST_USER_ID = '11111111-1111-4111-a111-111111111111';
  const TEST_ORG_ID = '22222222-2222-4222-a222-222222222222';
  const TEST_WORKSPACE_ID = '33333333-3333-4333-a333-333333333333';
  const TEST_CORRELATION_ID = '44444444-4444-4444-a444-444444444444';
  const TEST_THREAD_ID = '55555555-5555-4555-a555-555555555555';
  const TEST_RUN_ID = '66666666-6666-4666-a666-666666666666';
  const TEST_MESSAGE_ID = '77777777-7777-4777-a777-777777777777';
  const TEST_ASSISTANT_MSG_ID = '88888888-8888-4888-a888-888888888888';
  const TEST_QUERY = 'What is the enterprise encryption policy?';

  let validRequestContext: RequestContext;

  const callOrder: string[] = [];

  beforeEach(() => {
    callOrder.length = 0;
    jest.clearAllMocks();

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

    mockRuntimeService = new AgentRuntimeService();
    jest.spyOn(mockRuntimeService, 'createInitialState').mockImplementation((reqCtx, input) => {
      callOrder.push('createInitialState');
      return {
        runId: input.runId || TEST_RUN_ID,
        correlationId: reqCtx.metadata.correlationId,
        workspaceId: reqCtx.tenantScope!.workspaceId,
        userId: reqCtx.principal.userId,
        threadId: input.threadId,
        originalQuery: input.originalQuery,
        normalizedQuery: input.originalQuery,
        roles: ['contributor'],
        searchQueries: [],
        userMemories: [],
        workspaceMemories: [],
        threadHistory: [],
        memoryFetchStatus: 'EMPTY',
        routeDecision: 'knowledge_query',
        classificationReason: 'Factual enterprise query',
        clarificationNeeded: false,
        evidenceItems: [],
        draftResponse: '',
        extractedClaims: [],
        verificationResults: [],
        verificationScore: null,
        finalAnswer: '',
        executionStatus: undefined,
        candidateMemory: null,
        errors: [],
      } as unknown as AgentState;
    });

    jest.spyOn(mockRuntimeService, 'createExecutionContext').mockImplementation(() => {
      return {
        supabaseClient: {} as any,
      };
    });

    mockPersistenceService = new AgentRunPersistenceService();
    jest.spyOn(mockPersistenceService, 'createRun').mockImplementation(async () => {
      callOrder.push('createRun');
      return {
        run: {
          id: TEST_RUN_ID,
          workspaceId: TEST_WORKSPACE_ID,
          threadId: TEST_THREAD_ID,
          initiatingMessageId: TEST_MESSAGE_ID,
          assistantMessageId: null,
          userId: TEST_USER_ID,
          correlationId: TEST_CORRELATION_ID,
          query: TEST_QUERY,
          status: 'accepted',
          verificationConfidenceScore: null,
          startedAt: new Date(),
          completedAt: null,
        },
        initiatingMessageId: TEST_MESSAGE_ID,
      };
    });

    jest.spyOn(mockPersistenceService, 'transitionRunStatus').mockImplementation(async () => {
      callOrder.push('transitionRunStatus');
      return {
        id: TEST_RUN_ID,
        workspaceId: TEST_WORKSPACE_ID,
        threadId: TEST_THREAD_ID,
        initiatingMessageId: TEST_MESSAGE_ID,
        assistantMessageId: null,
        userId: TEST_USER_ID,
        correlationId: TEST_CORRELATION_ID,
        query: TEST_QUERY,
        status: 'running',
        verificationConfidenceScore: null,
        startedAt: new Date(),
        completedAt: null,
      };
    });

    jest.spyOn(mockPersistenceService, 'finalizeRun').mockImplementation(async (_reqCtx, params) => {
      callOrder.push('finalizeRun');
      return {
        id: TEST_RUN_ID,
        workspaceId: TEST_WORKSPACE_ID,
        threadId: TEST_THREAD_ID,
        initiatingMessageId: TEST_MESSAGE_ID,
        assistantMessageId: params.assistantMessage ? TEST_ASSISTANT_MSG_ID : null,
        userId: TEST_USER_ID,
        correlationId: TEST_CORRELATION_ID,
        query: TEST_QUERY,
        status: params.status,
        verificationConfidenceScore: params.verificationConfidenceScore ?? null,
        startedAt: new Date(),
        completedAt: new Date(),
      };
    });

    mockRetrievalOrchestrator = new RetrievalOrchestratorService();
    jest.spyOn(mockRetrievalOrchestrator, 'createNodeOptions').mockReturnValue({} as any);

    orchestrator = new RunsOrchestratorService(
      mockRuntimeService,
      mockPersistenceService,
      mockRetrievalOrchestrator,
    );
  });

  // =========================================================================
  // 1. HAPPY PATHS
  // =========================================================================
  describe('Happy Paths', () => {
    it('executes a completed run and commits assistant message with citations', async () => {
      jest.spyOn(graph, 'invoke').mockImplementation(async () => {
        callOrder.push('graphInvoke');
        return {
          finalAnswer: 'Data is encrypted with AES-256 at rest.',
          executionStatus: 'completed',
          verificationScore: 0.95,
          verificationResults: [
            {
              claimId: 'c1',
              claimText: 'Data is encrypted with AES-256 at rest.',
              status: 'SUPPORTED',
              citedChunkIds: ['chunk-1'],
              entailmentScore: 0.95,
              explanation: 'Fully verified.',
            },
          ],
        } as unknown as AgentState;
      });

      const params: ExecuteRunParams = {
        threadId: TEST_THREAD_ID,
        query: TEST_QUERY,
      };

      const result = await orchestrator.executeRun(params, validRequestContext);

      expect(result.status).toBe('completed');
      expect(result.finalResponse).toBe('Data is encrypted with AES-256 at rest.');
      expect(result.verificationScore).toBe(0.95);
      expect(result.citations).toHaveLength(1);
      expect(result.citations![0].claimText).toBe('Data is encrypted with AES-256 at rest.');
      expect(result.assistantMessageId).toBe(TEST_ASSISTANT_MSG_ID);

      // Verify exact lifecycle order
      expect(callOrder).toEqual([
        'createRun',
        'transitionRunStatus',
        'createInitialState',
        'graphInvoke',
        'finalizeRun',
      ]);
    });

    it('executes a declined_uncertain run and commits uncertainty assistant message', async () => {
      jest.spyOn(graph, 'invoke').mockImplementation(async () => {
        callOrder.push('graphInvoke');
        return {
          finalAnswer: 'I am unable to provide a verified answer based on the available retrieved context.',
          executionStatus: 'declined_uncertain',
          verificationScore: 0.50,
          verificationResults: [],
        } as unknown as AgentState;
      });

      const params: ExecuteRunParams = {
        threadId: TEST_THREAD_ID,
        query: TEST_QUERY,
      };

      const result = await orchestrator.executeRun(params, validRequestContext);

      expect(result.status).toBe('declined_uncertain');
      expect(result.finalResponse).toContain('unable to provide a verified answer');
      expect(result.assistantMessageId).toBe(TEST_ASSISTANT_MSG_ID);

      expect(mockPersistenceService.finalizeRun).toHaveBeenCalledWith(
        validRequestContext,
        expect.objectContaining({
          status: 'declined_uncertain',
          assistantMessage: expect.objectContaining({
            content: expect.stringContaining('unable to provide a verified answer'),
          }),
        }),
        undefined,
      );
    });
  });

  // =========================================================================
  // 2. FAILURE PATHS & ORDERING
  // =========================================================================
  describe('Failure Paths & Ordering Invariants', () => {
    it('fails fast and does not invoke graph if createRun fails', async () => {
      jest.spyOn(mockPersistenceService, 'createRun').mockRejectedValue(new Error('DB connection refused'));
      const graphInvokeSpy = jest.spyOn(graph, 'invoke');

      await expect(
        orchestrator.executeRun({ threadId: TEST_THREAD_ID, query: TEST_QUERY }, validRequestContext),
      ).rejects.toThrow('DB connection refused');

      expect(graphInvokeSpy).not.toHaveBeenCalled();
      expect(mockPersistenceService.transitionRunStatus).not.toHaveBeenCalled();
      expect(mockPersistenceService.finalizeRun).not.toHaveBeenCalled();
    });

    it('fails fast and does not invoke graph if transition to running fails', async () => {
      jest.spyOn(mockPersistenceService, 'transitionRunStatus').mockRejectedValue(new Error('Lock conflict'));
      const graphInvokeSpy = jest.spyOn(graph, 'invoke');

      await expect(
        orchestrator.executeRun({ threadId: TEST_THREAD_ID, query: TEST_QUERY }, validRequestContext),
      ).rejects.toThrow('Lock conflict');

      expect(graphInvokeSpy).not.toHaveBeenCalled();
      expect(mockPersistenceService.finalizeRun).not.toHaveBeenCalled();
    });

    it('catches graph execution exception, maps to failed, and NEVER commits assistant message', async () => {
      jest.spyOn(graph, 'invoke').mockRejectedValue(new Error('OpenAI 503 Provider Outage'));

      const result = await orchestrator.executeRun(
        { threadId: TEST_THREAD_ID, query: TEST_QUERY },
        validRequestContext,
      );

      expect(result.status).toBe('failed');
      expect(result.error?.code).toBe('EXECUTION_FAILED');
      expect(result.assistantMessageId).toBeNull();

      expect(mockPersistenceService.finalizeRun).toHaveBeenCalledWith(
        validRequestContext,
        expect.objectContaining({
          status: 'failed',
          assistantMessage: undefined, // strictly undefined
        }),
        undefined,
      );
    });

    it('maps operational verification failure from graph to failed status without assistant message', async () => {
      jest.spyOn(graph, 'invoke').mockResolvedValue({
        finalAnswer: 'Citation verification failed due to a system or provider error.',
        executionStatus: 'failed',
        verificationScore: null,
      } as unknown as AgentState);

      const result = await orchestrator.executeRun(
        { threadId: TEST_THREAD_ID, query: TEST_QUERY },
        validRequestContext,
      );

      expect(result.status).toBe('failed');
      expect(result.error?.code).toBe('VERIFICATION_FAILED');

      expect(mockPersistenceService.finalizeRun).toHaveBeenCalledWith(
        validRequestContext,
        expect.objectContaining({
          status: 'failed',
          assistantMessage: undefined,
        }),
        undefined,
      );
    });
  });

  // =========================================================================
  // 3. CANCELLATION & ABORT SIGNAL
  // =========================================================================
  describe('Cancellation & Abort Signal', () => {
    it('handles AbortSignal cancellation and maps to cancelled status without assistant message', async () => {
      const abortController = new AbortController();
      abortController.abort(new Error('Client aborted request'));

      const result = await orchestrator.executeRun(
        { threadId: TEST_THREAD_ID, query: TEST_QUERY },
        validRequestContext,
        undefined,
        { signal: abortController.signal },
      );

      expect(result.status).toBe('cancelled');
      expect(result.error?.code).toBe('EXECUTION_CANCELLED');

      expect(mockPersistenceService.finalizeRun).toHaveBeenCalledWith(
        validRequestContext,
        expect.objectContaining({
          status: 'cancelled',
          assistantMessage: undefined,
        }),
        undefined,
      );
    });
  });

  // =========================================================================
  // 4. SECURITY & IMMUTABILITY INVARIANTS
  // =========================================================================
  describe('Security & Invariants', () => {
    it('rejects unauthenticated RequestContext', async () => {
      const invalidContext = {} as RequestContext;

      await expect(
        orchestrator.executeRun({ threadId: TEST_THREAD_ID, query: TEST_QUERY }, invalidContext),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects invalid threadId format', async () => {
      await expect(
        orchestrator.executeRun({ threadId: 'invalid-thread', query: TEST_QUERY }, validRequestContext),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects empty query', async () => {
      await expect(
        orchestrator.executeRun({ threadId: TEST_THREAD_ID, query: '   ' }, validRequestContext),
      ).rejects.toThrow(BadRequestException);
    });

    it('sanitizes error messages to prevent credential and secret leakage', async () => {
      jest.spyOn(graph, 'invoke').mockRejectedValue(
        new Error('Failed request with Bearer eyJhbGciOi... and sk-proj-123456789'),
      );

      const result = await orchestrator.executeRun(
        { threadId: TEST_THREAD_ID, query: TEST_QUERY },
        validRequestContext,
      );

      expect(result.error?.message).not.toContain('eyJhbGciOi');
      expect(result.error?.message).not.toContain('sk-proj-123456789');
      expect(result.error?.message).toContain('[REDACTED]');
    });
  });
});

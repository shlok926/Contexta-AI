import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  createInitialAgentState,
  type AgentState,
  PROTECTED_CONTEXT_FIELDS,
} from '../../src/state';
import { graph } from '../../src/graph';
import type { IDraftGeneratorProvider } from '../../src/draft-response/draft-generator.interface';
import type { IVerificationProvider } from '../../src/citation-verification/verification-provider.interface';
import type { IRetrievalAdapter, DenseChunkCandidate, SparseChunkCandidate } from '../../src/research/retrieval.interface';
import type { IEmbeddingProvider } from '../../src/research/embedding.interface';

describe('N3.8-C6: End-to-End Graph Verification Gate & Execution Flow', () => {
  const TEST_RUN_ID = '11111111-1111-4111-a111-111111111111';
  const TEST_CORRELATION_ID = '22222222-2222-4222-a222-222222222222';
  const TEST_WORKSPACE_ID = '33333333-3333-4333-a333-333333333333';
  const TEST_USER_ID = '44444444-4444-4444-a444-444444444444';
  const TEST_THREAD_ID = '55555555-5555-4555-a555-555555555555';
  const TEST_QUERY = 'What is the corporate data retention policy?';

  function createTestState(overrides: Partial<AgentState> = {}): AgentState {
    return {
      ...createInitialAgentState({
        runId: TEST_RUN_ID,
        correlationId: TEST_CORRELATION_ID,
        workspaceId: TEST_WORKSPACE_ID,
        userId: TEST_USER_ID,
        threadId: TEST_THREAD_ID,
        originalQuery: TEST_QUERY,
      }),
      ...overrides,
    };
  }

  const mockDraftProvider: IDraftGeneratorProvider = {
    generateDraft: jest.fn<any>().mockResolvedValue({
      answer: 'Corporate audit logs are retained for 7 years in cold storage.',
      extractedClaims: [
        {
          claimId: 'temp_claim_1',
          claimText: 'Corporate audit logs are retained for 7 years in cold storage.',
          citedChunkIds: ['chunk_101'],
        },
      ],
    }),
  };

  const mockEmbeddingProvider: IEmbeddingProvider = {
    generateQueryEmbedding: jest.fn<any>().mockResolvedValue(new Array(1536).fill(0.01)),
  };

  const mockRetrievalAdapter: IRetrievalAdapter = {
    searchDense: jest.fn<any>().mockResolvedValue([
      {
        chunkId: 'chunk_101',
        documentId: 'doc-1',
        documentVersionId: 'ver-1',
        chunkOffset: 0,
        content: 'Corporate audit logs are retained for 7 years in cold storage.',
        similarity: 0.95,
        documentTitle: 'Compliance Manual',
        sourceType: 'compliance',
      } as DenseChunkCandidate,
    ]),
    searchSparse: jest.fn<any>().mockResolvedValue([] as SparseChunkCandidate[]),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createConfig = (verificationProvider: IVerificationProvider) => ({
    configurable: {
      researchOptions: {
        embeddingProvider: mockEmbeddingProvider,
        retrievalAdapter: mockRetrievalAdapter,
      },
      draftResponseOptions: {
        draftGeneratorProvider: mockDraftProvider,
      },
      citationVerificationOptions: {
        verificationProvider,
      },
    },
  });

  it('C6-001 & C6-003 & C6-004 & C6-005: Fully SUPPORTED claims with score >= 0.75 route to ReportNode (completed)', async () => {
    const mockVerifier: IVerificationProvider = {
      verify: jest.fn<any>().mockResolvedValue({
        evaluations: [
          {
            claimId: `claim_${TEST_RUN_ID}_0`,
            status: 'SUPPORTED',
            entailmentScore: 1.0,
            citedChunkIds: ['chunk_101'],
            explanation: 'Fully entailed by Compliance Manual.',
          },
        ],
      }),
    };

    const state = createTestState({ routeDecision: 'knowledge_query' });
    const result = await graph.invoke(state, createConfig(mockVerifier));

    expect(result.verificationResults).toHaveLength(1);
    expect(result.verificationResults[0].status).toBe('SUPPORTED');
    expect(result.verificationScore).toBe(1.0);
    expect(result.executionStatus).toBe('completed');
    expect(result.finalAnswer).toBe('Corporate audit logs are retained for 7 years in cold storage.');
  });

  it('C6-006: SUPPORTED claims with score < 0.75 route to UncertaintyNode (declined_uncertain)', async () => {
    const mockVerifier: IVerificationProvider = {
      verify: jest.fn<any>().mockResolvedValue({
        evaluations: [
          {
            claimId: `claim_${TEST_RUN_ID}_0`,
            status: 'SUPPORTED',
            entailmentScore: 0.60, // below 0.75 threshold
            citedChunkIds: ['chunk_101'],
            explanation: 'Supported with low confidence.',
          },
        ],
      }),
    };

    const state = createTestState({ routeDecision: 'knowledge_query' });
    const result = await graph.invoke(state, createConfig(mockVerifier));

    expect(result.verificationScore).toBe(0.60);
    expect(result.executionStatus).toBe('declined_uncertain');
    expect(result.finalAnswer).toContain('unable to provide a verified answer');
  });

  it('C6-007: PARTIALLY_SUPPORTED claims route to UncertaintyNode', async () => {
    const mockVerifier: IVerificationProvider = {
      verify: jest.fn<any>().mockResolvedValue({
        evaluations: [
          {
            claimId: `claim_${TEST_RUN_ID}_0`,
            status: 'PARTIALLY_SUPPORTED',
            entailmentScore: 0.70,
            citedChunkIds: ['chunk_101'],
            explanation: 'Only duration is supported.',
          },
        ],
      }),
    };

    const state = createTestState({ routeDecision: 'knowledge_query' });
    const result = await graph.invoke(state, createConfig(mockVerifier));

    expect(result.verificationResults[0].status).toBe('PARTIALLY_SUPPORTED');
    expect(result.executionStatus).toBe('declined_uncertain');
    expect(result.finalAnswer).toContain('unable to provide a verified answer');
  });

  it('C6-008: CONTRADICTED claims route to UncertaintyNode', async () => {
    const mockVerifier: IVerificationProvider = {
      verify: jest.fn<any>().mockResolvedValue({
        evaluations: [
          {
            claimId: `claim_${TEST_RUN_ID}_0`,
            status: 'CONTRADICTED',
            entailmentScore: 0.0,
            citedChunkIds: ['chunk_101'],
            explanation: 'Refuted by evidence.',
          },
        ],
      }),
    };

    const state = createTestState({ routeDecision: 'knowledge_query' });
    const result = await graph.invoke(state, createConfig(mockVerifier));

    expect(result.verificationResults[0].status).toBe('CONTRADICTED');
    expect(result.executionStatus).toBe('declined_uncertain');
  });

  it('C6-009: INSUFFICIENT_EVIDENCE claims route to UncertaintyNode', async () => {
    const mockVerifier: IVerificationProvider = {
      verify: jest.fn<any>().mockResolvedValue({
        evaluations: [
          {
            claimId: `claim_${TEST_RUN_ID}_0`,
            status: 'INSUFFICIENT_EVIDENCE',
            entailmentScore: 0.0,
            citedChunkIds: [],
            explanation: 'Evidence lacks duration details.',
          },
        ],
      }),
    };

    const state = createTestState({ routeDecision: 'knowledge_query' });
    const result = await graph.invoke(state, createConfig(mockVerifier));

    expect(result.verificationResults[0].status).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.executionStatus).toBe('declined_uncertain');
  });

  it('C6-010: CONFLICTING_EVIDENCE claims route to UncertaintyNode', async () => {
    const mockVerifier: IVerificationProvider = {
      verify: jest.fn<any>().mockResolvedValue({
        evaluations: [
          {
            claimId: `claim_${TEST_RUN_ID}_0`,
            status: 'CONFLICTING_EVIDENCE',
            entailmentScore: 0.4,
            citedChunkIds: ['chunk_101'],
            explanation: 'Dual documents conflict.',
          },
        ],
      }),
    };

    const state = createTestState({ routeDecision: 'knowledge_query' });
    const result = await graph.invoke(state, createConfig(mockVerifier));

    expect(result.verificationResults[0].status).toBe('CONFLICTING_EVIDENCE');
    expect(result.executionStatus).toBe('declined_uncertain');
  });

  it('C6-011 & C6-012 & C6-013: Operational VERIFICATION_FAILED routes to VerificationFailedNode (failed)', async () => {
    const failingVerifier: IVerificationProvider = {
      verify: jest.fn<any>().mockRejectedValue(new Error('OpenAI 503 Provider Outage')),
    };

    const state = createTestState({ routeDecision: 'knowledge_query' });
    const result = await graph.invoke(state, createConfig(failingVerifier));

    expect(result.verificationResults[0].status).toBe('VERIFICATION_FAILED');
    expect(result.verificationScore).toBeNull();
    expect(result.executionStatus).toBe('failed');
    expect(result.finalAnswer).toContain('Citation verification failed due to a system or provider error');
  });

  it('C6-014..C6-018: Mixed claim statuses evaluate deterministically to UncertaintyNode or VerificationFailedNode', async () => {
    const mixedDraftProvider: IDraftGeneratorProvider = {
      generateDraft: jest.fn<any>().mockResolvedValue({
        answer: 'Claim 1 and Claim 2.',
        extractedClaims: [
          { claimId: 'c1', claimText: 'Claim 1', citedChunkIds: ['chunk_101'] },
          { claimId: 'c2', claimText: 'Claim 2', citedChunkIds: ['chunk_101'] },
        ],
      }),
    };

    const mixedVerifier: IVerificationProvider = {
      verify: jest.fn<any>().mockResolvedValue({
        evaluations: [
          {
            claimId: `claim_${TEST_RUN_ID}_0`,
            status: 'SUPPORTED',
            entailmentScore: 1.0,
            citedChunkIds: ['chunk_101'],
            explanation: 'Supported.',
          },
          {
            claimId: `claim_${TEST_RUN_ID}_1`,
            status: 'INSUFFICIENT_EVIDENCE',
            entailmentScore: 0.0,
            citedChunkIds: [],
            explanation: 'Insufficient.',
          },
        ],
      }),
    };

    const config = {
      configurable: {
        researchOptions: {
          embeddingProvider: mockEmbeddingProvider,
          retrievalAdapter: mockRetrievalAdapter,
        },
        draftResponseOptions: {
          draftGeneratorProvider: mixedDraftProvider,
        },
        citationVerificationOptions: {
          verificationProvider: mixedVerifier,
        },
      },
    };

    const state = createTestState({ routeDecision: 'knowledge_query' });
    const result = await graph.invoke(state, config);

    expect(result.verificationResults).toHaveLength(2);
    expect(result.executionStatus).toBe('declined_uncertain');
  });

  it('C6-002 & C6-033: direct_conversational route bypasses research, drafting, and verification entirely', async () => {
    const mockVerifier: IVerificationProvider = {
      verify: jest.fn<any>(),
    };

    const state = createTestState({
      originalQuery: 'Hello! How are you?',
      routeDecision: 'direct_conversational',
    });

    const result = await graph.invoke(state, createConfig(mockVerifier));

    expect(mockVerifier.verify).not.toHaveBeenCalled();
    expect(result.verificationResults).toEqual([]);
    expect(result.finalAnswer).toBe('Direct conversational answer.');
    expect(result.executionStatus).toBe('completed');
  });

  it('C6-027: Protected execution context remains completely immutable through full graph run', async () => {
    const mockVerifier: IVerificationProvider = {
      verify: jest.fn<any>().mockResolvedValue({
        evaluations: [
          {
            claimId: `claim_${TEST_RUN_ID}_0`,
            status: 'SUPPORTED',
            entailmentScore: 1.0,
            citedChunkIds: ['chunk_101'],
            explanation: 'Ok.',
          },
        ],
      }),
    };

    const state = createTestState({ routeDecision: 'knowledge_query' });
    const result = await graph.invoke(state, createConfig(mockVerifier));

    for (const field of PROTECTED_CONTEXT_FIELDS) {
      expect((result as any)[field]).toBe((state as any)[field]);
    }
  });
});

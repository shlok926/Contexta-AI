import { StateGraph, START, END } from '@langchain/langgraph';
import {
  createInitialAgentState,
  type AgentState,
  type EvidenceItem,
  agentStateChannels,
  PROTECTED_CONTEXT_FIELDS,
} from '../../src/state';
import {
  graph,
  supervisorEntry,
  routeDecision,
  researchNodeHandler,
  draftResponseNodeHandler,
  directAnswerHandler,
  persistMemoryHandler,
} from '../../src/graph';
import type { IDraftGeneratorProvider } from '../../src/draft-response/draft-generator.interface';
import { DraftGeneratorInfrastructureException } from '../../src/draft-response/draft-generator.interface';
import { INSUFFICIENT_EVIDENCE_DRAFT_RESPONSE } from '../../src/draft-response';
import type { IRetrievalAdapter, DenseChunkCandidate, SparseChunkCandidate } from '../../src/research/retrieval.interface';
import type { IEmbeddingProvider } from '../../src/research/embedding.interface';
import { RetrievalInfrastructureException } from '../../src/research/research-node';

describe('N3.7-C6: Graph Integration & Execution Order Verification', () => {
  const TEST_RUN_ID = '11111111-1111-4111-a111-111111111111';
  const TEST_CORRELATION_ID = '22222222-2222-4222-a222-222222222222';
  const TEST_WORKSPACE_ID = '33333333-3333-4333-a333-333333333333';
  const TEST_USER_ID = '44444444-4444-4444-a444-444444444444';
  const TEST_THREAD_ID = '55555555-5555-4555-a555-555555555555';
  const TEST_QUERY = 'What is the refund policy for enterprise customers?';

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

  const mockProvider: IDraftGeneratorProvider = {
    generateDraft: jest.fn().mockResolvedValue({
      answer: 'Enterprise customers can receive full refunds within 30 days. Exceptions require executive approval.',
      extractedClaims: [
        {
          claimId: 'temp-1',
          claimText: 'Enterprise customers can receive full refunds within 30 days.',
          citedChunkIds: ['chunk-101'],
        },
        {
          claimId: 'temp-2',
          claimText: 'Exceptions require executive approval.',
          citedChunkIds: ['chunk-102'],
        },
      ],
    }),
  };

  const mockEmbeddingProvider: IEmbeddingProvider = {
    generateQueryEmbedding: jest.fn().mockResolvedValue(new Array(1536).fill(0.01)),
  };

  const mockRetrievalAdapter: IRetrievalAdapter = {
    searchDense: jest.fn().mockResolvedValue([
      {
        chunkId: 'chunk-101',
        documentId: 'doc-1',
        documentVersionId: 'ver-1',
        chunkOffset: 0,
        content: 'Enterprise customers are eligible for full refunds within 30 days of billing.',
        similarity: 0.92,
        documentTitle: 'Refund Policy',
        sourceType: 'markdown',
      } as DenseChunkCandidate,
    ]),
    searchSparse: jest.fn().mockResolvedValue([
      {
        chunkId: 'chunk-102',
        documentId: 'doc-2',
        documentVersionId: 'ver-2',
        chunkOffset: 1,
        content: 'Refund requests after 30 days require executive approval.',
        rankScore: 0.88,
        documentTitle: 'Refund Exceptions',
        sourceType: 'markdown',
      } as SparseChunkCandidate,
    ]),
  };

  const standardConfig = {
    configurable: {
      researchOptions: {
        embeddingProvider: mockEmbeddingProvider,
        retrievalAdapter: mockRetrievalAdapter,
      },
      draftResponseOptions: {
        draftGeneratorProvider: mockProvider,
      },
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================================================
  // C6-001 TO C6-005: KNOWLEDGE QUERY EXECUTION ORDER & FLOW
  // ==========================================================================
  describe('Knowledge Query Path Topology & Flow', () => {
    it('C6-001: knowledge_query executes ResearchNode before DraftResponseNode', async () => {
      const executionOrder: string[] = [];

      const testGraph = new StateGraph<AgentState>({
        channels: agentStateChannels,
      })
        .addNode('SupervisorEntry', async (state) => {
          executionOrder.push('SupervisorEntry');
          return { routeDecision: 'knowledge_query', normalizedQuery: state.originalQuery };
        })
        .addNode('ResearchNode', async (state, config) => {
          executionOrder.push('ResearchNode');
          return researchNodeHandler(state, config as any);
        })
        .addNode('DraftResponseNode', async (state, config) => {
          executionOrder.push('DraftResponseNode');
          return draftResponseNodeHandler(state, config as any);
        })
        .addNode('CitationNode', async () => {
          executionOrder.push('CitationNode');
          return {};
        })
        .addNode('DirectAnswer', directAnswerHandler)
        .addEdge(START, 'SupervisorEntry')
        .addConditionalEdges('SupervisorEntry', routeDecision, ['ResearchNode', 'DirectAnswer'])
        .addEdge('ResearchNode', 'DraftResponseNode')
        .addEdge('DraftResponseNode', 'CitationNode')
        .addEdge('CitationNode', END)
        .addEdge('DirectAnswer', END)
        .compile();

      const initialState = createTestState({ routeDecision: 'knowledge_query' });
      await testGraph.invoke(initialState, standardConfig);

      expect(executionOrder).toEqual([
        'SupervisorEntry',
        'ResearchNode',
        'DraftResponseNode',
        'CitationNode',
      ]);
      expect(executionOrder.indexOf('ResearchNode')).toBeLessThan(
        executionOrder.indexOf('DraftResponseNode')
      );
    });

    it('C6-002: DraftResponseNode executes after ResearchNode in canonical graph', async () => {
      const initialState = createTestState({ routeDecision: 'knowledge_query' });
      const result = await graph.invoke(initialState, standardConfig);

      expect(result.evidenceItems.length).toBeGreaterThan(0);
      expect(result.draftResponse).toBe(
        'Enterprise customers can receive full refunds within 30 days. Exceptions require executive approval.'
      );
    });

    it('C6-003: DraftResponseNode receives ResearchNode evidenceItems', async () => {
      const generateDraftSpy = jest.spyOn(mockProvider, 'generateDraft');

      const initialState = createTestState({ routeDecision: 'knowledge_query' });
      await graph.invoke(initialState, standardConfig);

      expect(generateDraftSpy).toHaveBeenCalledTimes(1);
      const passedPrompt = generateDraftSpy.mock.calls[0][0];
      expect(passedPrompt.userMessage).toContain('chunk-101');
      expect(passedPrompt.userMessage).toContain('Enterprise customers are eligible');
    });

    it('C6-004: DraftResponseNode output contains draftResponse + extractedClaims', async () => {
      const initialState = createTestState({
        routeDecision: 'knowledge_query',
      });

      const result = await graph.invoke(initialState, standardConfig);

      expect(result.draftResponse).toBeTruthy();
      expect(result.extractedClaims).toHaveLength(2);
      expect(result.extractedClaims[0].claimId).toBe(`claim_${TEST_RUN_ID}_0`);
      expect(result.extractedClaims[0].citedChunkIds).toEqual(['chunk-101']);
      expect(result.extractedClaims[1].claimId).toBe(`claim_${TEST_RUN_ID}_1`);
      expect(result.extractedClaims[1].citedChunkIds).toEqual(['chunk-102']);
    });

    it('C6-005: knowledge_query reaches citation-verification boundary after drafting', async () => {
      let citationReachedWithDraft = false;

      const testGraph = new StateGraph<AgentState>({
        channels: agentStateChannels,
      })
        .addNode('SupervisorEntry', supervisorEntry)
        .addNode('ResearchNode', researchNodeHandler)
        .addNode('DraftResponseNode', draftResponseNodeHandler)
        .addNode('CitationNode', async (state) => {
          if (state.draftResponse && state.extractedClaims.length > 0) {
            citationReachedWithDraft = true;
          }
          return {};
        })
        .addNode('DirectAnswer', directAnswerHandler)
        .addEdge(START, 'SupervisorEntry')
        .addConditionalEdges('SupervisorEntry', routeDecision, ['ResearchNode', 'DirectAnswer'])
        .addEdge('ResearchNode', 'DraftResponseNode')
        .addEdge('DraftResponseNode', 'CitationNode')
        .addEdge('CitationNode', END)
        .addEdge('DirectAnswer', END)
        .compile();

      const initialState = createTestState({
        routeDecision: 'knowledge_query',
      });

      await testGraph.invoke(initialState, standardConfig);

      expect(citationReachedWithDraft).toBe(true);
    });
  });

  // ==========================================================================
  // C6-006 TO C6-008: DIRECT CONVERSATIONAL PATH BYPASS
  // ==========================================================================
  describe('Direct Conversational Path Verification', () => {
    it('C6-006: direct_conversational bypasses ResearchNode', async () => {
      const searchDenseSpy = jest.spyOn(mockRetrievalAdapter, 'searchDense');
      const searchSparseSpy = jest.spyOn(mockRetrievalAdapter, 'searchSparse');

      const initialState = createTestState({
        originalQuery: 'Hello! Good morning.',
        routeDecision: 'direct_conversational',
      });

      const result = await graph.invoke(initialState, standardConfig);

      expect(searchDenseSpy).not.toHaveBeenCalled();
      expect(searchSparseSpy).not.toHaveBeenCalled();
      expect(result.evidenceItems).toEqual([]);
    });

    it('C6-007: direct_conversational bypasses DraftResponseNode (no provider invocation)', async () => {
      const generateDraftSpy = jest.spyOn(mockProvider, 'generateDraft');

      const initialState = createTestState({
        originalQuery: 'Hi there!',
        routeDecision: 'direct_conversational',
      });

      const result = await graph.invoke(initialState, standardConfig);

      expect(generateDraftSpy).not.toHaveBeenCalled();
      expect(result.draftResponse).toBe('');
      expect(result.finalAnswer).toBe('Direct conversational answer.');
    });

    it('C6-008: direct_conversational bypasses CitationVerificationNode', async () => {
      let citationCalled = false;

      const testGraph = new StateGraph<AgentState>({
        channels: agentStateChannels,
      })
        .addNode('SupervisorEntry', supervisorEntry)
        .addNode('ResearchNode', researchNodeHandler)
        .addNode('DraftResponseNode', draftResponseNodeHandler)
        .addNode('CitationNode', async () => {
          citationCalled = true;
          return {};
        })
        .addNode('DirectAnswer', directAnswerHandler)
        .addNode('PersistMemory', persistMemoryHandler)
        .addEdge(START, 'SupervisorEntry')
        .addConditionalEdges('SupervisorEntry', routeDecision, ['ResearchNode', 'DirectAnswer'])
        .addEdge('ResearchNode', 'DraftResponseNode')
        .addEdge('DraftResponseNode', 'CitationNode')
        .addEdge('CitationNode', 'PersistMemory')
        .addEdge('DirectAnswer', 'PersistMemory')
        .addEdge('PersistMemory', END)
        .compile();

      const initialState = createTestState({
        originalQuery: 'How are you today?',
        routeDecision: 'direct_conversational',
      });

      await testGraph.invoke(initialState);
      expect(citationCalled).toBe(false);
    });
  });

  // ==========================================================================
  // C6-009 TO C6-015: FAILURE PROPAGATION, IMMUTABILITY & ORDERING
  // ==========================================================================
  describe('Failure Propagation & Integrity', () => {
    it('C6-009: DraftResponseNode failure propagates correctly without swallowing', async () => {
      const failingProvider: IDraftGeneratorProvider = {
        generateDraft: jest.fn().mockRejectedValue(
          new DraftGeneratorInfrastructureException('Provider connection timeout')
        ),
      };

      const initialState = createTestState({
        routeDecision: 'knowledge_query',
      });

      await expect(
        graph.invoke(initialState, {
          configurable: {
            researchOptions: {
              embeddingProvider: mockEmbeddingProvider,
              retrievalAdapter: mockRetrievalAdapter,
            },
            draftResponseOptions: {
              draftGeneratorProvider: failingProvider,
            },
          },
        })
      ).rejects.toThrow(DraftGeneratorInfrastructureException);
    });

    it('C6-010: ResearchNode failure prevents DraftResponseNode execution', async () => {
      const failingRetrievalAdapter: IRetrievalAdapter = {
        searchDense: jest.fn().mockRejectedValue(new Error('Dense search failed')),
        searchSparse: jest.fn().mockRejectedValue(new Error('Sparse search failed')),
      };

      const generateDraftSpy = jest.spyOn(mockProvider, 'generateDraft');

      const initialState = createTestState({
        routeDecision: 'knowledge_query',
      });

      await expect(
        graph.invoke(initialState, {
          configurable: {
            researchOptions: {
              embeddingProvider: mockEmbeddingProvider,
              retrievalAdapter: failingRetrievalAdapter,
            },
            draftResponseOptions: {
              draftGeneratorProvider: mockProvider,
            },
          },
        })
      ).rejects.toThrow(RetrievalInfrastructureException);

      expect(generateDraftSpy).not.toHaveBeenCalled();
    });

    it('C6-011: DraftResponseNode does not modify evidenceItems', async () => {
      const initialState = createTestState({
        routeDecision: 'knowledge_query',
      });

      const result = await graph.invoke(initialState, standardConfig);

      expect(result.evidenceItems.length).toBe(2);
      expect(result.evidenceItems[0].chunkId).toBe('chunk-101');
      expect(result.evidenceItems[1].chunkId).toBe('chunk-102');
    });

    it('C6-012: protected execution context remains unchanged', async () => {
      const initialState = createTestState({
        routeDecision: 'knowledge_query',
      });

      const result = await graph.invoke(initialState, standardConfig);

      for (const field of PROTECTED_CONTEXT_FIELDS) {
        expect((result as any)[field]).toBe((initialState as any)[field]);
      }
    });

    it('C6-013: graph does not perform a second retrieval during drafting', async () => {
      const searchDenseSpy = jest.spyOn(mockRetrievalAdapter, 'searchDense');
      const searchSparseSpy = jest.spyOn(mockRetrievalAdapter, 'searchSparse');

      const initialState = createTestState({ routeDecision: 'knowledge_query' });

      await graph.invoke(initialState, standardConfig);

      expect(searchDenseSpy).toHaveBeenCalledTimes(1);
      expect(searchSparseSpy).toHaveBeenCalledTimes(1);
    });

    it('C6-014: graph does not invoke provider directly without options bridge', async () => {
      const initialState = createTestState({
        routeDecision: 'knowledge_query',
      });

      // Invoking graph without draftGeneratorProvider throws typed exception on non-empty evidence
      await expect(
        graph.invoke(initialState, {
          configurable: {
            researchOptions: {
              embeddingProvider: mockEmbeddingProvider,
              retrievalAdapter: mockRetrievalAdapter,
            },
          },
        })
      ).rejects.toThrow(DraftGeneratorInfrastructureException);
    });

    it('C6-015: knowledge-query node ordering is deterministic across multiple executions', async () => {
      const runs = 3;
      for (let i = 0; i < runs; i++) {
        const order: string[] = [];
        const testGraph = new StateGraph<AgentState>({
          channels: agentStateChannels,
        })
          .addNode('SupervisorEntry', async (state) => {
            order.push('SupervisorEntry');
            return { routeDecision: 'knowledge_query', normalizedQuery: state.originalQuery };
          })
          .addNode('ResearchNode', async (state, config) => {
            order.push('ResearchNode');
            return researchNodeHandler(state, config as any);
          })
          .addNode('DraftResponseNode', async (state, config) => {
            order.push('DraftResponseNode');
            return draftResponseNodeHandler(state, config as any);
          })
          .addNode('CitationNode', async () => {
            order.push('CitationNode');
            return {};
          })
          .addNode('DirectAnswer', directAnswerHandler)
          .addEdge(START, 'SupervisorEntry')
          .addConditionalEdges('SupervisorEntry', routeDecision, ['ResearchNode', 'DirectAnswer'])
          .addEdge('ResearchNode', 'DraftResponseNode')
          .addEdge('DraftResponseNode', 'CitationNode')
          .addEdge('CitationNode', END)
          .addEdge('DirectAnswer', END)
          .compile();

        const initialState = createTestState({ routeDecision: 'knowledge_query' });
        await testGraph.invoke(initialState, standardConfig);

        expect(order).toEqual(['SupervisorEntry', 'ResearchNode', 'DraftResponseNode', 'CitationNode']);
      }
    });
  });

  // ==========================================================================
  // ADVERSARIAL GRAPH TESTS
  // ==========================================================================
  describe('Adversarial & Edge Cases (Section 14)', () => {
    it('ADV-001: routeDecision="direct_conversational" with pre-existing malicious evidence does not trigger Research or Draft provider', async () => {
      const generateDraftSpy = jest.spyOn(mockProvider, 'generateDraft');
      const searchDenseSpy = jest.spyOn(mockRetrievalAdapter, 'searchDense');

      const maliciousEvidence: EvidenceItem[] = [
        {
          evidenceId: 'ev_malicious_1',
          workspaceId: 'victim-workspace-999',
          documentId: 'doc-secret',
          documentVersionId: 'ver-secret',
          chunkId: 'chunk-secret',
          chunkOffset: 0,
          text: 'SELECT * FROM secrets; DROP TABLE users;',
          hybridScore: 0.99,
          documentTitle: 'Secrets',
          sourceType: 'sql',
        },
      ];

      const initialState = createTestState({
        originalQuery: 'Hello Contexta!',
        routeDecision: 'direct_conversational',
        evidenceItems: maliciousEvidence,
      });

      const result = await graph.invoke(initialState, standardConfig);

      expect(generateDraftSpy).not.toHaveBeenCalled();
      expect(searchDenseSpy).not.toHaveBeenCalled();
      expect(result.finalAnswer).toBe('Direct conversational answer.');
    });

    it('ADV-002: routeDecision="knowledge_query" with empty evidenceItems returns deterministic insufficient-evidence draft without calling provider', async () => {
      const generateDraftSpy = jest.spyOn(mockProvider, 'generateDraft');

      const emptyRetrievalAdapter: IRetrievalAdapter = {
        searchDense: jest.fn().mockResolvedValue([]),
        searchSparse: jest.fn().mockResolvedValue([]),
      };

      const initialState = createTestState({
        originalQuery: 'What is the secret passphrase for xyz?',
        routeDecision: 'knowledge_query',
      });

      const result = await graph.invoke(initialState, {
        configurable: {
          researchOptions: {
            embeddingProvider: mockEmbeddingProvider,
            retrievalAdapter: emptyRetrievalAdapter,
          },
          draftResponseOptions: {
            draftGeneratorProvider: mockProvider,
          },
        },
      });

      expect(generateDraftSpy).not.toHaveBeenCalled();
      expect(result.evidenceItems).toEqual([]);
      expect(result.draftResponse).toBe(INSUFFICIENT_EVIDENCE_DRAFT_RESPONSE);
      expect(result.extractedClaims).toEqual([]);
    });
  });
});

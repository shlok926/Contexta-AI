import {
  researchNode,
  RetrievalInfrastructureException,
} from '../../src/research/research-node';
import { IEmbeddingProvider } from '../../src/research/embedding.interface';
import {
  IRerankerProvider,
  RerankCandidate,
  RerankResult,
} from '../../src/research/reranker.interface';
import {
  IRetrievalAdapter,
  DenseChunkCandidate,
  SparseChunkCandidate,
} from '../../src/research/retrieval.interface';
import { AgentState } from '../../src/state';

describe('ResearchNode (N3.6)', () => {
  const baseState: AgentState = {
    runId: '550e8400-e29b-41d4-a716-446655440000',
    correlationId: '660e8400-e29b-41d4-a716-446655440000',
    workspaceId: '110e8400-e29b-41d4-a716-446655440000',
    userId: '220e8400-e29b-41d4-a716-446655440000',
    threadId: '440e8400-e29b-41d4-a716-446655440000',
    originalQuery: 'How does authentication work in Contexta?',
    normalizedQuery: 'authentication contexta architecture',
    userMemories: [],
    workspaceMemories: [],
    threadHistory: [],
    memoryFetchStatus: 'HYDRATED',
    routeDecision: 'knowledge_query',
    evidenceItems: [],
    draftResponse: '',
    extractedClaims: [],
    verificationResults: [],
    finalAnswer: '',
    verificationScore: null,
    executionStatus: 'running',
    errors: [],
  };


  const mockDenseChunks: DenseChunkCandidate[] = [
    {
      chunkId: 'chunk-1',
      documentId: 'doc-1',
      documentVersionId: 'ver-1',
      chunkOffset: 0,
      content: 'Authentication uses JWT tokens verified cryptographically.',
      similarity: 0.92,
      documentTitle: 'Auth Guide',
      sourceType: 'markdown',
    },
    {
      chunkId: 'chunk-2',
      documentId: 'doc-2',
      documentVersionId: 'ver-2',
      chunkOffset: 3,
      content: 'Session validation uses request-scoped supabase client.',
      similarity: 0.88,
      documentTitle: 'Session Management',
      sourceType: 'markdown',
    },
  ];

  const mockSparseChunks: SparseChunkCandidate[] = [
    {
      chunkId: 'chunk-1',
      documentId: 'doc-1',
      documentVersionId: 'ver-1',
      chunkOffset: 0,
      content: 'Authentication uses JWT tokens verified cryptographically.',
      rankScore: 0.75,
      documentTitle: 'Auth Guide',
      sourceType: 'markdown',
    },
    {
      chunkId: 'chunk-3',
      documentId: 'doc-3',
      documentVersionId: 'ver-3',
      chunkOffset: 1,
      content: 'RBAC permissions checked per workspace role.',
      rankScore: 0.65,
      documentTitle: 'RBAC Architecture',
      sourceType: 'markdown',
    },
  ];

  let mockEmbeddingProvider: IEmbeddingProvider;
  let mockRetrievalAdapter: IRetrievalAdapter;
  let mockRerankerProvider: IRerankerProvider;

  beforeEach(() => {
    mockEmbeddingProvider = {
      generateQueryEmbedding: jest.fn().mockResolvedValue(new Array(1536).fill(0.01)),
    };
    mockRetrievalAdapter = {
      searchDense: jest.fn().mockResolvedValue(mockDenseChunks),
      searchSparse: jest.fn().mockResolvedValue(mockSparseChunks),
    };
    mockRerankerProvider = {
      rerank: jest.fn().mockImplementation(
        async (
          _query: string,
          candidates: readonly RerankCandidate[],
        ): Promise<readonly RerankResult[]> => {
          return candidates.map((c, i) => ({
            chunkId: c.chunkId,
            rerankScore: 0.99 - i * 0.1,
          }));
        },
      ),
    };
  });

  it('bypasses retrieval when routeDecision is direct_conversational', async () => {
    const directState: AgentState = {
      ...baseState,
      routeDecision: 'direct_conversational',
    };

    const delta = await researchNode(directState, undefined, {
      embeddingProvider: mockEmbeddingProvider,
      retrievalAdapter: mockRetrievalAdapter,
      rerankerProvider: mockRerankerProvider,
    });

    expect(delta).toEqual({});
    expect(mockRetrievalAdapter.searchDense).not.toHaveBeenCalled();
    expect(mockRetrievalAdapter.searchSparse).not.toHaveBeenCalled();
  });

  it('executes parallel retrieval, fuses candidates, reranks, and outputs minimal evidenceItems delta', async () => {
    const delta = await researchNode(baseState, undefined, {
      embeddingProvider: mockEmbeddingProvider,
      retrievalAdapter: mockRetrievalAdapter,
      rerankerProvider: mockRerankerProvider,
    });

    expect(delta).toHaveProperty('evidenceItems');
    expect(Object.keys(delta)).toEqual(['evidenceItems']);

    const items = delta.evidenceItems!;
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(5);

    // Verify deterministic evidenceId convention
    for (const item of items) {
      expect(item.evidenceId).toBe(`ev_${baseState.runId}_${item.chunkId}`);
      expect(item.workspaceId).toBe(baseState.workspaceId);
      expect(typeof item.hybridScore).toBe('number');
      expect(item.hybridScore).toBeGreaterThan(0);
    }

    // Verify chunk-1 is present with merged scores and RRF hybridScore
    const chunk1 = items.find((i) => i.chunkId === 'chunk-1');
    expect(chunk1).toBeDefined();
    expect(chunk1!.denseScore).toBe(0.92);
    expect(chunk1!.sparseScore).toBe(0.75);
    expect(chunk1!.hybridScore).toBeCloseTo(1 / 61 + 1 / 61, 8); // rank 1 in both
  });

  it('handles embedding failure with sparse-only fallback without throwing RetrievalInfrastructureException', async () => {
    mockEmbeddingProvider.generateQueryEmbedding = jest
      .fn()
      .mockRejectedValue(new Error('OpenAI embedding 504 Gateway Timeout'));

    const delta = await researchNode(baseState, undefined, {
      embeddingProvider: mockEmbeddingProvider,
      retrievalAdapter: mockRetrievalAdapter,
      rerankerProvider: mockRerankerProvider,
    });

    expect(delta.evidenceItems).toBeDefined();
    expect(delta.evidenceItems!.length).toBeGreaterThan(0);

    // Items should come from sparse channel and preserve RRF score
    for (const item of delta.evidenceItems!) {
      expect(item.sparseScore).toBeDefined();
      expect(typeof item.hybridScore).toBe('number');
      expect(item.hybridScore).toBeGreaterThan(0);
    }
  });

  it('handles reranker timeout with RRF order fallback while strictly preserving RRF hybridScore', async () => {
    mockRerankerProvider.rerank = jest
      .fn()
      .mockRejectedValue(new Error('Reranker timeout'));

    const delta = await researchNode(baseState, undefined, {
      embeddingProvider: mockEmbeddingProvider,
      retrievalAdapter: mockRetrievalAdapter,
      rerankerProvider: mockRerankerProvider,
    });

    expect(delta.evidenceItems).toBeDefined();
    expect(delta.evidenceItems!.length).toBeGreaterThan(0);

    // Preserves top fused RRF candidate at position 0
    expect(delta.evidenceItems![0].chunkId).toBe('chunk-1');
    expect(delta.evidenceItems![0].hybridScore).toBeCloseTo(1 / 61 + 1 / 61, 8);

    // Verify all items are strictly ordered by hybridScore DESC (RRF order)
    for (let i = 0; i < delta.evidenceItems!.length - 1; i++) {
      expect(delta.evidenceItems![i].hybridScore).toBeGreaterThanOrEqual(
        delta.evidenceItems![i + 1].hybridScore,
      );
    }
  });


  it('throws RetrievalInfrastructureException when BOTH channels fail', async () => {
    mockRetrievalAdapter.searchDense = jest
      .fn()
      .mockRejectedValue(new Error('PostgreSQL connection pool exhausted'));
    mockRetrievalAdapter.searchSparse = jest
      .fn()
      .mockRejectedValue(new Error('PostgreSQL connection pool exhausted'));

    await expect(
      researchNode(baseState, undefined, {
        embeddingProvider: mockEmbeddingProvider,
        retrievalAdapter: mockRetrievalAdapter,
        rerankerProvider: mockRerankerProvider,
      }),
    ).rejects.toThrow(RetrievalInfrastructureException);
  });

  it('returns empty evidenceItems array when no matching documents exist', async () => {
    mockRetrievalAdapter.searchDense = jest.fn().mockResolvedValue([]);
    mockRetrievalAdapter.searchSparse = jest.fn().mockResolvedValue([]);

    const delta = await researchNode(baseState, undefined, {
      embeddingProvider: mockEmbeddingProvider,
      retrievalAdapter: mockRetrievalAdapter,
      rerankerProvider: mockRerankerProvider,
    });

    expect(delta).toEqual({ evidenceItems: [] });
  });
});

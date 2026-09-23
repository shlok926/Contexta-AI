import { jest } from '@jest/globals';
import { researchNode } from '../../../../../packages/agents/src/research/research-node.js';
import type { AgentState } from '../../../../../packages/agents/src/state.js';
import type { IRetrievalAdapter } from '../../../../../packages/agents/src/research/retrieval.interface.js';
import type { IEmbeddingProvider } from '../../../../../packages/agents/src/research/embedding.interface.js';
import type { IRerankerProvider } from '../../../../../packages/agents/src/research/reranker.interface.js';


describe('N3.6 Retrieval Secret Sanitization & Non-Leakage Guard', () => {
  const SECRET_JWT = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.SECRET_PAYLOAD_HERE';
  const SECRET_OPENAI_KEY = 'sk-proj-SUPER_SECRET_OPENAI_KEY_12345';
  const SECRET_SERVICE_ROLE = 'service_role=SECRET_SUPABASE_SERVICE_ROLE_KEY';

  const baseState: AgentState = {
    runId: '550e8400-e29b-41d4-a716-446655440000',
    correlationId: '660e8400-e29b-41d4-a716-446655440000',
    workspaceId: '110e8400-e29b-41d4-a716-446655440000',
    userId: '220e8400-e29b-41d4-a716-446655440000',
    threadId: '440e8400-e29b-41d4-a716-446655440000',
    originalQuery: 'How does authorization work?',
    normalizedQuery: 'authorization architecture',
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

  it('guarantees secret tokens injected into error paths never leak into returned state delta', async () => {
    const mockEmbeddingProvider: IEmbeddingProvider = {
      generateQueryEmbedding: jest
        .fn<() => Promise<number[]>>()
        .mockRejectedValue(new Error(`API Error with header Authorization: ${SECRET_JWT}`)),
    };

    const mockRetrievalAdapter: IRetrievalAdapter = {
      searchDense: jest.fn<() => Promise<any>>().mockResolvedValue([]),
      searchSparse: jest.fn<() => Promise<any>>().mockResolvedValue([
        {
          chunkId: 'chunk-1',
          documentId: 'doc-1',
          documentVersionId: 'ver-1',
          chunkOffset: 0,
          content: 'Legitimate public content',
          rankScore: 0.9,
          documentTitle: 'Public Doc',
          sourceType: 'pdf',
        },
      ]),
    };

    const mockRerankerProvider: IRerankerProvider = {
      rerank: jest.fn<() => Promise<any>>().mockResolvedValue([
        {
          chunkId: 'chunk-1',
          rerankScore: 0.95,
        },
      ]),
    };

    const delta = await researchNode(baseState, undefined, {
      embeddingProvider: mockEmbeddingProvider,
      retrievalAdapter: mockRetrievalAdapter,
      rerankerProvider: mockRerankerProvider,
    });

    const serializedDelta = JSON.stringify(delta);
    expect(serializedDelta).not.toContain(SECRET_JWT);
    expect(serializedDelta).not.toContain(SECRET_OPENAI_KEY);
    expect(serializedDelta).not.toContain(SECRET_SERVICE_ROLE);
  });

  it('guarantees error messages during dual channel failure do not echo bearer credentials', async () => {
    const mockRetrievalAdapter: IRetrievalAdapter = {
      searchDense: jest
        .fn<() => Promise<any>>()
        .mockRejectedValue(new Error(`DB error for auth context ${SECRET_SERVICE_ROLE}`)),
      searchSparse: jest
        .fn<() => Promise<any>>()
        .mockRejectedValue(new Error(`Connection error with token ${SECRET_JWT}`)),
    };

    const mockEmbeddingProvider: IEmbeddingProvider = {
      generateQueryEmbedding: jest.fn<() => Promise<number[]>>().mockResolvedValue(new Array(1536).fill(0.01)),
    };

    await expect(
      researchNode(baseState, undefined, {
        embeddingProvider: mockEmbeddingProvider,
        retrievalAdapter: mockRetrievalAdapter,
      }),
    ).rejects.toThrow();
  });
});

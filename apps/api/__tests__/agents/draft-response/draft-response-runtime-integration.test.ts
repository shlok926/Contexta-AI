import { jest } from '@jest/globals';
import { AgentRuntimeService } from '../../../src/modules/agents/services/agent-runtime.service.js';
import { OpenAIDraftGeneratorAdapter } from '../../../src/modules/agents/adapters/openai-draft-generator.adapter.js';
import { MockDraftGeneratorAdapter } from '../../../src/modules/agents/adapters/mock-draft-generator.adapter.js';
import { createRequestContext } from '../../../src/modules/identity/interfaces/request-context.interface.js';
import type { RequestContext } from '../../../src/modules/identity/interfaces/request-context.interface.js';
import { ROLE_PERMISSIONS_MAP } from '../../../src/modules/workspace/interfaces/permissions.interface.js';
import {
  graph,
  type IRetrievalAdapter,
  type IEmbeddingProvider,
  type DenseChunkCandidate,
  type SparseChunkCandidate,
} from '../../../../../packages/agents/src/index.js';

describe('N3.7-C7: Agent Runtime & Adapter End-to-End Integration', () => {
  let runtimeService: AgentRuntimeService;
  let validRequestContext: RequestContext;
  const originalFetch = global.fetch;

  const TEST_USER_ID = '66666666-7777-4888-8999-000000000000';
  const TEST_ORG_ID = '11111111-2222-4333-8444-555555555555';
  const TEST_WORKSPACE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const TEST_CORRELATION_ID = 'cccccccc-dddd-4eee-8fff-000000000000';
  const TEST_THREAD_ID = 'ffffffff-0000-4111-8222-333333333333';
  const TEST_RUN_ID = '99999999-8888-4777-8666-555555555555';

  const mockEmbeddingProvider: IEmbeddingProvider = {
    generateQueryEmbedding: jest.fn<any>().mockResolvedValue(new Array(1536).fill(0.01)),
  };

  const mockRetrievalAdapter: IRetrievalAdapter = {
    searchDense: jest.fn<any>().mockResolvedValue([
      {
        chunkId: 'chunk-api-1',
        documentId: 'doc-api-1',
        documentVersionId: 'ver-1',
        chunkOffset: 0,
        content: 'Contexta-AI provides automated citation verification with sub-100ms latency.',
        similarity: 0.96,
        documentTitle: 'Performance Specs',
        sourceType: 'markdown',
      } as DenseChunkCandidate,
    ]),
    searchSparse: jest.fn<any>().mockResolvedValue([
      {
        chunkId: 'chunk-api-2',
        documentId: 'doc-api-2',
        documentVersionId: 'ver-2',
        chunkOffset: 1,
        content: 'Enterprise deployments support private VPC isolation.',
        rankScore: 0.91,
        documentTitle: 'Enterprise Architecture',
        sourceType: 'markdown',
      } as SparseChunkCandidate,
    ]),
  };

  beforeEach(() => {
    validRequestContext = createRequestContext({
      principal: {
        userId: TEST_USER_ID,
        email: 'enterprise-user@contexta.ai',
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

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('API-E2E-001: should create initial state and execute full knowledge graph with OpenAIDraftGeneratorAdapter', async () => {
    const initialState = runtimeService.createInitialState(validRequestContext, {
      runId: TEST_RUN_ID,
      threadId: TEST_THREAD_ID,
      originalQuery: 'What are the latency specs and deployment options?',
    });

    initialState.routeDecision = 'knowledge_query';

    const mockOpenAIPayload = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              answer: 'Contexta-AI provides automated citation verification with sub-100ms latency, and enterprise deployments support private VPC isolation.',
              extractedClaims: [
                {
                  claimId: 'temp_0',
                  claimText: 'Contexta-AI provides automated citation verification with sub-100ms latency.',
                  citedChunkIds: ['chunk-api-1'],
                },
                {
                  claimId: 'temp_1',
                  claimText: 'Enterprise deployments support private VPC isolation.',
                  citedChunkIds: ['chunk-api-2'],
                },
              ],
            }),
          },
        },
      ],
    };

    (global as any).fetch = jest.fn<any>().mockResolvedValue({
      ok: true,
      json: async () => mockOpenAIPayload,
    });

    const openAIAdapter = new OpenAIDraftGeneratorAdapter({
      apiKey: 'sk-test-key-mock',
      modelName: 'gpt-4o-mini',
    });

    const result = await graph.invoke(initialState, {
      configurable: {
        researchOptions: {
          embeddingProvider: mockEmbeddingProvider,
          retrievalAdapter: mockRetrievalAdapter,
        },
        draftResponseOptions: {
          draftGeneratorProvider: openAIAdapter,
        },
      },
    });

    expect(result.evidenceItems).toHaveLength(2);
    expect(result.draftResponse).toBe(
      'Contexta-AI provides automated citation verification with sub-100ms latency, and enterprise deployments support private VPC isolation.'
    );
    expect(result.extractedClaims).toHaveLength(2);
    expect(result.extractedClaims[0].claimId).toBe(`claim_${initialState.runId}_0`);
    expect(result.extractedClaims[0].citedChunkIds).toEqual(['chunk-api-1']);
    expect(result.extractedClaims[1].claimId).toBe(`claim_${initialState.runId}_1`);
    expect(result.extractedClaims[1].citedChunkIds).toEqual(['chunk-api-2']);
  });

  it('API-E2E-002: should execute full direct conversational flow cleanly without invoking adapter', async () => {
    const initialState = runtimeService.createInitialState(validRequestContext, {
      runId: TEST_RUN_ID,
      threadId: TEST_THREAD_ID,
      originalQuery: 'Good afternoon Contexta!',
    });

    initialState.routeDecision = 'direct_conversational';

    const fetchSpy = jest.fn<any>();
    (global as any).fetch = fetchSpy;

    const mockAdapter = new MockDraftGeneratorAdapter();

    const result = await graph.invoke(initialState, {
      configurable: {
        researchOptions: {
          embeddingProvider: mockEmbeddingProvider,
          retrievalAdapter: mockRetrievalAdapter,
        },
        draftResponseOptions: {
          draftGeneratorProvider: mockAdapter,
        },
      },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.evidenceItems).toEqual([]);
    expect(result.draftResponse).toBe('');
    expect(result.finalAnswer).toBe('Direct conversational answer.');
  });
});

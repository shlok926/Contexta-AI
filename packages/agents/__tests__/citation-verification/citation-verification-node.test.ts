import { describe, it, expect, jest } from '@jest/globals';
import { citationVerificationNode } from '../../src/citation-verification/citation-verification-node';
import type { IVerificationProvider } from '../../src/citation-verification/verification-provider.interface';
import { VerificationInfrastructureException } from '../../src/citation-verification/verification.errors';
import type {
  VerificationRequest,
  VerificationProviderResponse,
} from '../../src/citation-verification/verification.types';
import type { AgentState, EvidenceItem } from '../../src/state';

describe('N3.8-C5: CitationVerificationNode Orchestration & Verification Cascade', () => {
  const sampleEvidence: EvidenceItem[] = [
    {
      evidenceId: 'ev_1',
      workspaceId: '11111111-1111-1111-1111-111111111111',
      documentId: 'doc_1',
      documentVersionId: 'ver_1',
      chunkId: 'chunk_101',
      chunkOffset: 0,
      text: 'Total revenue reached ₹10 crore in 2024. The platform does not support WebAuthn authentication.',
      documentTitle: 'Annual Financial & Security Report 2024',
      sourceType: 'compliance',
      hybridScore: 0.92,
    },
    {
      evidenceId: 'ev_2',
      workspaceId: '11111111-1111-1111-1111-111111111111',
      documentId: 'doc_2',
      documentVersionId: 'ver_2',
      chunkId: 'chunk_102',
      chunkOffset: 1,
      text: 'All server infrastructure is deployed strictly in AWS us-east-1 and eu-west-1.',
      documentTitle: 'Infrastructure Deployment Specs',
      sourceType: 'infrastructure',
      hybridScore: 0.88,
    },
  ];

  const createBaseState = (overrides?: Partial<AgentState>): AgentState => ({
    runId: '22222222-2222-2222-2222-222222222222',
    correlationId: '33333333-3333-3333-3333-333333333333',
    workspaceId: '11111111-1111-1111-1111-111111111111',
    userId: '44444444-4444-4444-4444-444444444444',
    threadId: '55555555-5555-5555-5555-555555555555',
    originalQuery: 'What is the 2024 revenue and deployment regions?',
    normalizedQuery: 'What is the 2024 revenue and deployment regions?',
    userMemories: [],
    workspaceMemories: [],
    threadHistory: [],
    memoryFetchStatus: 'EMPTY',
    routeDecision: 'knowledge_query',
    evidenceItems: sampleEvidence,
    draftResponse: 'Revenue was ₹10 crore in 2024. Servers are deployed in AWS.',
    extractedClaims: [
      {
        claimId: 'claim_1',
        claimText: 'Total revenue reached ₹10 crore in 2024.',
        citedChunkIds: ['chunk_101'],
      },
      {
        claimId: 'claim_2',
        claimText: 'All server infrastructure is deployed strictly in AWS us-east-1.',
        citedChunkIds: ['chunk_102'],
      },
    ],
    verificationResults: [],
    finalAnswer: '',
    verificationScore: null,
    executionStatus: 'running',
    errors: [],
    ...overrides,
  });

  const createMockProvider = (
    handler?: (req: VerificationRequest) => Promise<VerificationProviderResponse>,
  ): IVerificationProvider => ({
    verify: jest.fn(
      handler ||
        (async (req: VerificationRequest) => ({
          evaluations: req.claims.map((c) => ({
            claimId: c.claimId,
            status: 'SUPPORTED' as const,
            entailmentScore: 1.0,
            citedChunkIds: [...c.citedChunkIds],
            explanation: `Supported by mock for ${c.claimId}`,
          })),
        })),
    ),
  });

  it('C5-001: No claims → deterministic empty verification result', async () => {
    const state = createBaseState({ extractedClaims: [] });
    const provider = createMockProvider();

    const delta = await citationVerificationNode(state, undefined, {
      verificationProvider: provider,
    });

    expect(delta.verificationResults).toEqual([]);
    expect(provider.verify).not.toHaveBeenCalled();
  });

  it('C5-002: One claim + Stage 1 CONTRADICTED → 0 provider calls', async () => {
    const state = createBaseState({
      extractedClaims: [
        {
          claimId: 'claim_contradicted',
          claimText: 'Total revenue reached ₹50 crore in 2024.', // chunk_101 asserts ₹10 crore in 2024
          citedChunkIds: ['chunk_101'],
        },
      ],
    });
    const provider = createMockProvider();

    const delta = await citationVerificationNode(state, undefined, {
      verificationProvider: provider,
    });

    expect(provider.verify).not.toHaveBeenCalled();
    expect(delta.verificationResults).toHaveLength(1);
    expect(delta.verificationResults![0].status).toBe('CONTRADICTED');
    expect(delta.verificationResults![0].stage1Passed).toBe(false);
    expect(delta.verificationResults![0].stage2Evaluated).toBe(false);
    expect(delta.verificationResults![0].failureReason).toContain('quantitative mismatch');
  });

  it('C5-003: One claim + Stage 1 INSUFFICIENT_EVIDENCE → 0 provider calls', async () => {
    const state = createBaseState({
      extractedClaims: [
        {
          claimId: 'claim_unsupported',
          claimText: 'The sky is blue.',
          citedChunkIds: [], // Empty citations
        },
      ],
    });
    const provider = createMockProvider();

    const delta = await citationVerificationNode(state, undefined, {
      verificationProvider: provider,
    });

    expect(provider.verify).not.toHaveBeenCalled();
    expect(delta.verificationResults).toHaveLength(1);
    expect(delta.verificationResults![0].status).toBe('INSUFFICIENT_EVIDENCE');
    expect(delta.verificationResults![0].stage1Passed).toBe(false);
    expect(delta.verificationResults![0].stage2Evaluated).toBe(false);
  });

  it('C5-004: One claim + Stage 1 PASS → provider called exactly once', async () => {
    const state = createBaseState({
      extractedClaims: [
        {
          claimId: 'claim_valid',
          claimText: 'Total revenue reached ₹10 crore in 2024.',
          citedChunkIds: ['chunk_101'],
        },
      ],
    });
    const provider = createMockProvider();

    const delta = await citationVerificationNode(state, undefined, {
      verificationProvider: provider,
    });

    expect(provider.verify).toHaveBeenCalledTimes(1);
    expect(delta.verificationResults).toHaveLength(1);
    expect(delta.verificationResults![0].status).toBe('SUPPORTED');
    expect(delta.verificationResults![0].stage1Passed).toBe(true);
    expect(delta.verificationResults![0].stage2Evaluated).toBe(true);
  });

  it('C5-005 & C5-006: Stage 1 deterministic terminal mappings', async () => {
    const state = createBaseState({
      extractedClaims: [
        {
          claimId: 'c_contra',
          claimText: 'Total revenue reached ₹99 crore in 2024.',
          citedChunkIds: ['chunk_101'],
        },
        {
          claimId: 'c_insuff',
          claimText: 'Claim with invalid chunk citation.',
          citedChunkIds: ['unknown_chunk_xyz'],
        },
      ],
    });
    const provider = createMockProvider();

    const delta = await citationVerificationNode(state, undefined, {
      verificationProvider: provider,
    });

    expect(provider.verify).not.toHaveBeenCalled();
    expect(delta.verificationResults).toHaveLength(2);
    expect(delta.verificationResults![0].status).toBe('CONTRADICTED');
    expect(delta.verificationResults![0].stage1Passed).toBe(false);
    expect(delta.verificationResults![1].status).toBe('INSUFFICIENT_EVIDENCE');
    expect(delta.verificationResults![1].stage1Passed).toBe(false);
  });

  it('C5-007..C5-011: Valid Stage 2 canonical outcomes', async () => {
    const state = createBaseState({
      extractedClaims: [
        { claimId: 'c_supp', claimText: 'Supported claim', citedChunkIds: ['chunk_101'] },
        { claimId: 'c_part', claimText: 'Partially supported claim', citedChunkIds: ['chunk_101'] },
        { claimId: 'c_cont', claimText: 'Contradicted claim', citedChunkIds: ['chunk_101'] },
        { claimId: 'c_conf', claimText: 'Conflicting claim', citedChunkIds: ['chunk_101'] },
        { claimId: 'c_insu', claimText: 'Insufficient claim', citedChunkIds: ['chunk_101'] },
      ],
    });

    const provider = createMockProvider(async () => ({
      evaluations: [
        { claimId: 'c_supp', status: 'SUPPORTED', entailmentScore: 1.0, citedChunkIds: ['chunk_101'], explanation: 'Entailed' },
        { claimId: 'c_part', status: 'PARTIALLY_SUPPORTED', entailmentScore: 0.7, citedChunkIds: ['chunk_101'], explanation: 'Partial' },
        { claimId: 'c_cont', status: 'CONTRADICTED', entailmentScore: 0.0, citedChunkIds: ['chunk_101'], explanation: 'Refuted' },
        { claimId: 'c_conf', status: 'CONFLICTING_EVIDENCE', entailmentScore: 0.4, citedChunkIds: ['chunk_101'], conflictingChunkIds: ['chunk_102'], explanation: 'Conflicting' },
        { claimId: 'c_insu', status: 'INSUFFICIENT_EVIDENCE', entailmentScore: 0.0, citedChunkIds: [], explanation: 'No evidence' },
      ],
    }));

    const delta = await citationVerificationNode(state, undefined, {
      verificationProvider: provider,
    });

    expect(delta.verificationResults).toHaveLength(5);
    expect(delta.verificationResults![0].status).toBe('SUPPORTED');
    expect(delta.verificationResults![1].status).toBe('PARTIALLY_SUPPORTED');
    expect(delta.verificationResults![2].status).toBe('CONTRADICTED');
    expect(delta.verificationResults![3].status).toBe('CONFLICTING_EVIDENCE');
    expect(delta.verificationResults![4].status).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('C5-012..C5-019: Provider operational failures normalize to VERIFICATION_FAILED', async () => {
    const state = createBaseState({
      extractedClaims: [
        { claimId: 'c1', claimText: 'Valid claim text', citedChunkIds: ['chunk_101'] },
      ],
    });

    const failingProvider: IVerificationProvider = {
      verify: jest.fn(async () => {
        throw new VerificationInfrastructureException('OpenAI 500: Internal Server Error');
      }),
    };

    const delta = await citationVerificationNode(state, undefined, {
      verificationProvider: failingProvider,
    });

    expect(delta.verificationResults).toHaveLength(1);
    expect(delta.verificationResults![0].status).toBe('VERIFICATION_FAILED');
    expect(delta.verificationResults![0].stage1Passed).toBe(true);
    expect(delta.verificationResults![0].stage2Evaluated).toBe(false);
    expect(delta.verificationResults![0].failureReason).toContain('OpenAI 500');
  });

  it('C5-020: Multiple claims with mixed Stage 1 outcomes (Provider called ONLY for Stage 1 passed claims)', async () => {
    const state = createBaseState({
      extractedClaims: [
        {
          claimId: 'claim_contra',
          claimText: 'Total revenue reached ₹80 crore in 2024.', // chunk_101 says ₹10 crore -> CONTRADICTED
          citedChunkIds: ['chunk_101'],
        },
        {
          claimId: 'claim_insuff',
          claimText: 'Claim with no citations.',
          citedChunkIds: [], // INSUFFICIENT_EVIDENCE
        },
        {
          claimId: 'claim_pass',
          claimText: 'Infrastructure is deployed in AWS us-east-1.',
          citedChunkIds: ['chunk_102'], // STAGE_1_PASSED
        },
      ],
    });

    let passedRequestClaims: any[] = [];
    const provider = createMockProvider(async (req) => {
      passedRequestClaims = [...req.claims];
      return {
        evaluations: [
          {
            claimId: 'claim_pass',
            status: 'SUPPORTED',
            entailmentScore: 1.0,
            citedChunkIds: ['chunk_102'],
            explanation: 'Directly supported by infrastructure doc.',
          },
        ],
      };
    });

    const delta = await citationVerificationNode(state, undefined, {
      verificationProvider: provider,
    });

    expect(provider.verify).toHaveBeenCalledTimes(1);
    expect(passedRequestClaims).toHaveLength(1);
    expect(passedRequestClaims[0].claimId).toBe('claim_pass');

    expect(delta.verificationResults).toHaveLength(3);
    expect(delta.verificationResults![0].claimId).toBe('claim_contra');
    expect(delta.verificationResults![0].status).toBe('CONTRADICTED');
    expect(delta.verificationResults![0].stage1Passed).toBe(false);

    expect(delta.verificationResults![1].claimId).toBe('claim_insuff');
    expect(delta.verificationResults![1].status).toBe('INSUFFICIENT_EVIDENCE');
    expect(delta.verificationResults![1].stage1Passed).toBe(false);

    expect(delta.verificationResults![2].claimId).toBe('claim_pass');
    expect(delta.verificationResults![2].status).toBe('SUPPORTED');
    expect(delta.verificationResults![2].stage1Passed).toBe(true);
    expect(delta.verificationResults![2].stage2Evaluated).toBe(true);
  });

  it('C5-021 & C5-022: Claim atomicity and isolation under mixed outcomes', async () => {
    const state = createBaseState({
      extractedClaims: [
        { claimId: 'c1', claimText: 'Claim 1 text', citedChunkIds: ['chunk_101'] },
        { claimId: 'c2', claimText: 'Claim 2 text', citedChunkIds: ['chunk_102'] },
      ],
    });

    // Provider returns evaluation for c1, but omits c2
    const provider = createMockProvider(async () => ({
      evaluations: [
        { claimId: 'c1', status: 'SUPPORTED', entailmentScore: 1.0, citedChunkIds: ['chunk_101'], explanation: 'Supported' },
      ],
    }));

    const delta = await citationVerificationNode(state, undefined, {
      verificationProvider: provider,
    });

    expect(delta.verificationResults).toHaveLength(2);
    expect(delta.verificationResults![0].status).toBe('SUPPORTED');
    expect(delta.verificationResults![1].status).toBe('VERIFICATION_FAILED');
  });

  it('C5-023: PARTIALLY_SUPPORTED remains preserved as a claim-level result', async () => {
    const state = createBaseState({
      extractedClaims: [
        { claimId: 'c1', claimText: 'Partially supported claim', citedChunkIds: ['chunk_101'] },
      ],
    });

    const provider = createMockProvider(async () => ({
      evaluations: [
        {
          claimId: 'c1',
          status: 'PARTIALLY_SUPPORTED',
          entailmentScore: 0.65,
          citedChunkIds: ['chunk_101'],
          explanation: 'Only some aspects entailed.',
        },
      ],
    }));

    const delta = await citationVerificationNode(state, undefined, {
      verificationProvider: provider,
    });

    expect(delta.verificationResults![0].status).toBe('PARTIALLY_SUPPORTED');
    expect(delta.verificationResults![0].entailmentScore).toBe(0.65);
  });

  it('C5-024: No response-level aggregation is introduced (verificationScore is not in delta)', async () => {
    const state = createBaseState();
    const provider = createMockProvider();

    const delta = await citationVerificationNode(state, undefined, {
      verificationProvider: provider,
    });

    expect(delta).toHaveProperty('verificationResults');
    expect(delta).not.toHaveProperty('verificationScore');
  });

  it('C5-025 & C5-026: Result ordering strictly follows extractedClaims order regardless of provider evaluation order', async () => {
    const state = createBaseState({
      extractedClaims: [
        { claimId: 'alpha', claimText: 'Alpha claim', citedChunkIds: ['chunk_101'] },
        { claimId: 'beta', claimText: 'Beta claim', citedChunkIds: ['chunk_102'] },
        { claimId: 'gamma', claimText: 'Gamma claim', citedChunkIds: ['chunk_101'] },
      ],
    });

    // Provider returns evaluations in reverse order: gamma, alpha, beta
    const provider = createMockProvider(async () => ({
      evaluations: [
        { claimId: 'gamma', status: 'SUPPORTED', entailmentScore: 1.0, citedChunkIds: ['chunk_101'], explanation: 'Gamma' },
        { claimId: 'alpha', status: 'SUPPORTED', entailmentScore: 1.0, citedChunkIds: ['chunk_101'], explanation: 'Alpha' },
        { claimId: 'beta', status: 'SUPPORTED', entailmentScore: 1.0, citedChunkIds: ['chunk_102'], explanation: 'Beta' },
      ],
    }));

    const delta = await citationVerificationNode(state, undefined, {
      verificationProvider: provider,
    });

    expect(delta.verificationResults!.map((r) => r.claimId)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('C5-027..C5-031: Candidate evidence data isolation and security boundary', async () => {
    let capturedRequest: VerificationRequest | undefined;
    const provider = createMockProvider(async (req) => {
      capturedRequest = req;
      return {
        evaluations: req.claims.map((c) => ({
          claimId: c.claimId,
          status: 'SUPPORTED',
          entailmentScore: 1.0,
          citedChunkIds: [...c.citedChunkIds],
          explanation: 'Ok',
        })),
      };
    });

    const state = createBaseState();
    await citationVerificationNode(state, undefined, { verificationProvider: provider });

    expect(capturedRequest).toBeDefined();
    // Verify evidence items in request are sanitized of workspace internal fields and retrieval scores
    for (const ev of capturedRequest!.candidateEvidence) {
      expect((ev as any).denseScore).toBeUndefined();
      expect((ev as any).sparseScore).toBeUndefined();
      expect((ev as any).hybridScore).toBeUndefined();
      expect((ev as any).workspaceId).toBeUndefined();
      expect((ev as any).documentVersionId).toBeUndefined();
    }
  });

  it('C5-032..C5-035: Protected state fields, original query, and evidence items remain unmodified', async () => {
    const state = createBaseState();
    const provider = createMockProvider();

    const delta = await citationVerificationNode(state, undefined, { verificationProvider: provider });

    expect(delta.runId).toBeUndefined();
    expect(delta.correlationId).toBeUndefined();
    expect(delta.workspaceId).toBeUndefined();
    expect(delta.userId).toBeUndefined();
    expect(delta.threadId).toBeUndefined();
    expect(delta.originalQuery).toBeUndefined();
    expect(delta.evidenceItems).toBeUndefined();
    expect(delta.extractedClaims).toBeUndefined();
    expect(delta.draftResponse).toBeUndefined();
  });

  it('C5-036: AbortSignal cancellation rejects before execution', async () => {
    const abortController = new AbortController();
    abortController.abort();

    const state = createBaseState();
    const provider = createMockProvider();

    await expect(
      citationVerificationNode(state, { signal: abortController.signal }, { verificationProvider: provider }),
    ).rejects.toThrow(VerificationInfrastructureException);
  });

  it('C5-037: Empty evidence items do not call provider', async () => {
    const state = createBaseState({
      evidenceItems: [],
      extractedClaims: [
        { claimId: 'c1', claimText: 'Claim with empty evidence', citedChunkIds: ['chunk_101'] },
      ],
    });
    const provider = createMockProvider();

    const delta = await citationVerificationNode(state, undefined, { verificationProvider: provider });

    expect(provider.verify).not.toHaveBeenCalled();
    expect(delta.verificationResults![0].status).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('C5-043: Direct conversational routing bypasses verification', async () => {
    const state = createBaseState({ routeDecision: 'direct_conversational' });
    const provider = createMockProvider();

    const delta = await citationVerificationNode(state, undefined, { verificationProvider: provider });

    expect(delta).toEqual({});
    expect(provider.verify).not.toHaveBeenCalled();
  });

  it('Missing provider configuration normalizes passed claims to VERIFICATION_FAILED', async () => {
    const state = createBaseState({
      extractedClaims: [
        { claimId: 'c1', claimText: 'Passes stage 1', citedChunkIds: ['chunk_101'] },
      ],
    });

    const delta = await citationVerificationNode(state, undefined, {});

    expect(delta.verificationResults![0].status).toBe('VERIFICATION_FAILED');
    expect(delta.verificationResults![0].failureReason).toContain('requires a configured IVerificationProvider');
  });
});

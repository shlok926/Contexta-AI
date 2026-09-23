import { AgentState, EvidenceItem } from '../state';
import { IEmbeddingProvider } from './embedding.interface';
import { IRerankerProvider, RerankCandidate } from './reranker.interface';
import {
  IRetrievalAdapter,
  DenseChunkCandidate,
  SparseChunkCandidate,
  FusedChunkCandidate,
} from './retrieval.interface';
import { reciprocalRankFusion, DEFAULT_RRF_K } from './rrf';

/**
 * Typed exception thrown when both retrieval channels fail due to infrastructure/database outage.
 */
export class RetrievalInfrastructureException extends Error {
  public readonly code: string = 'RETRIEVAL_INFRASTRUCTURE_FAILURE';

  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'RetrievalInfrastructureException';
    Object.setPrototypeOf(this, RetrievalInfrastructureException.prototype);
  }
}

export interface RunnableConfigLike {
  readonly configurable?: {
    readonly context?: {
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
      readonly [key: string]: unknown;
    };
    readonly [key: string]: unknown;
  };
  readonly signal?: AbortSignal;
  readonly [key: string]: unknown;
}

export interface ResearchNodeOptions {
  readonly embeddingProvider?: IEmbeddingProvider;
  readonly rerankerProvider?: IRerankerProvider;
  readonly retrievalAdapter?: IRetrievalAdapter;
  readonly denseSimilarityThreshold?: number;
  readonly denseCandidateLimit?: number;
  readonly sparseCandidateLimit?: number;
  readonly maxScanTuples?: number;
  readonly rrfConstant?: number;
  readonly rrfTopCandidates?: number;
  readonly finalEvidenceLimit?: number;
  readonly rerankerTimeoutMs?: number;
}

const DEFAULT_DENSE_SIMILARITY_THRESHOLD = 0.3;
const DEFAULT_DENSE_CANDIDATE_LIMIT = 60;
const DEFAULT_SPARSE_CANDIDATE_LIMIT = 60;
const DEFAULT_MAX_SCAN_TUPLES = 20000;
const DEFAULT_RRF_TOP_CANDIDATES = 20;
const DEFAULT_FINAL_EVIDENCE_LIMIT = 5;
const DEFAULT_RERANKER_TIMEOUT_MS = 150;

/**
 * ResearchNode (N3.6)
 * Executes dual dense + sparse retrieval, reciprocal rank fusion (RRF),
 * cross-encoder reranking, and evidence packaging.
 *
 * Emits minimal state delta: { evidenceItems: EvidenceItem[] }
 */
export async function researchNode(
  state: AgentState,
  config?: RunnableConfigLike,
  options?: ResearchNodeOptions,
): Promise<Partial<AgentState>> {
  // 1. Invariant Check: Bypass if routeDecision is not knowledge_query
  if (state.routeDecision !== 'knowledge_query') {
    return {};
  }

  // 2. Resolve query text & cancellation signal
  const query = state.normalizedQuery || state.originalQuery || '';
  if (!query.trim()) {
    return { evidenceItems: [] };
  }

  const signal = config?.signal ?? config?.configurable?.context?.signal;
  if (signal?.aborted) {
    throw new Error('ResearchNode aborted before execution');
  }

  const embeddingProvider = options?.embeddingProvider;
  const rerankerProvider = options?.rerankerProvider;
  const retrievalAdapter = options?.retrievalAdapter;

  const denseSimilarityThreshold =
    options?.denseSimilarityThreshold ?? DEFAULT_DENSE_SIMILARITY_THRESHOLD;
  const denseCandidateLimit =
    options?.denseCandidateLimit ?? DEFAULT_DENSE_CANDIDATE_LIMIT;
  const sparseCandidateLimit =
    options?.sparseCandidateLimit ?? DEFAULT_SPARSE_CANDIDATE_LIMIT;
  const maxScanTuples = options?.maxScanTuples ?? DEFAULT_MAX_SCAN_TUPLES;
  const rrfConstant = options?.rrfConstant ?? DEFAULT_RRF_K;
  const rrfTopCandidates =
    options?.rrfTopCandidates ?? DEFAULT_RRF_TOP_CANDIDATES;
  const finalEvidenceLimit =
    options?.finalEvidenceLimit ?? DEFAULT_FINAL_EVIDENCE_LIMIT;
  const rerankerTimeoutMs =
    options?.rerankerTimeoutMs ?? DEFAULT_RERANKER_TIMEOUT_MS;

  // 3. Parallel Dense and Sparse Candidate Retrieval
  let denseCandidates: readonly DenseChunkCandidate[] = [];
  let sparseCandidates: readonly SparseChunkCandidate[] = [];
  let denseError: Error | null = null;
  let sparseError: Error | null = null;

  const denseTask = async (): Promise<readonly DenseChunkCandidate[]> => {
    if (!retrievalAdapter || !embeddingProvider) {
      return [];
    }
    const queryEmbedding = await embeddingProvider.generateQueryEmbedding(
      query,
      { signal },
    );
    return await retrievalAdapter.searchDense(
      state.workspaceId,
      queryEmbedding,
      {
        matchThreshold: denseSimilarityThreshold,
        matchCount: denseCandidateLimit,
        maxScanTuples,
        signal,
      },
    );
  };

  const sparseTask = async (): Promise<readonly SparseChunkCandidate[]> => {
    if (!retrievalAdapter) {
      return [];
    }
    return await retrievalAdapter.searchSparse(state.workspaceId, query, {
      matchCount: sparseCandidateLimit,
      signal,
    });
  };

  const [denseSettled, sparseSettled] = await Promise.allSettled([
    denseTask(),
    sparseTask(),
  ]);

  if (denseSettled.status === 'fulfilled') {
    denseCandidates = denseSettled.value;
  } else {
    denseError = denseSettled.reason instanceof Error
      ? denseSettled.reason
      : new Error(String(denseSettled.reason));
  }

  if (sparseSettled.status === 'fulfilled') {
    sparseCandidates = sparseSettled.value;
  } else {
    sparseError = sparseSettled.reason instanceof Error
      ? sparseSettled.reason
      : new Error(String(sparseSettled.reason));
  }

  // 4. Safe Failure Handling
  // If BOTH channels encountered exceptions (and adapter was provided), fail as infrastructure outage
  if (retrievalAdapter && denseError && sparseError) {
    throw new RetrievalInfrastructureException(
      `Dual retrieval channels failed: Dense (${denseError.message}), Sparse (${sparseError.message})`,
      { denseError, sparseError },
    );
  }

  // 5. Reciprocal Rank Fusion (RRF, k=60)
  const fusedCandidates = reciprocalRankFusion(
    state.workspaceId,
    denseCandidates,
    sparseCandidates,
    {
      k: rrfConstant,
      topK: rrfTopCandidates,
    },
  );

  if (fusedCandidates.length === 0) {
    return { evidenceItems: [] };
  }

  // 6. Cross-Encoder Reranking
  let finalCandidates: readonly FusedChunkCandidate[] = fusedCandidates;

  if (rerankerProvider) {
    const rerankInput: RerankCandidate[] = fusedCandidates.map((c) => ({
      chunkId: c.chunkId,
      text: c.content,
      metadata: {
        documentId: c.documentId,
        documentVersionId: c.documentVersionId,
        chunkOffset: c.chunkOffset,
        documentTitle: c.documentTitle,
        sourceType: c.sourceType,
      },
      rrfScore: c.rrfScore,
    }));

    try {
      const rerankResults = await rerankerProvider.rerank(query, rerankInput, {
        topK: finalEvidenceLimit,
        signal,
        timeoutMs: rerankerTimeoutMs,
      });

      if (rerankResults && rerankResults.length > 0) {
        // Map ranked chunk IDs back to fused candidates preserving rerank order
        const candidateMap = new Map<string, FusedChunkCandidate>();
        for (const c of fusedCandidates) {
          candidateMap.set(c.chunkId, c);
        }

        const reordered: FusedChunkCandidate[] = [];
        for (const res of rerankResults) {
          const candidate = candidateMap.get(res.chunkId);
          if (candidate) {
            reordered.push(candidate);
          }
        }

        if (reordered.length > 0) {
          finalCandidates = reordered;
        }
      }
    } catch {
      // Observable fallback: preserve RRF order on reranker timeout or failure
      finalCandidates = fusedCandidates;
    }
  }

  // Slice to final evidence limit
  const selectedCandidates = finalCandidates.slice(0, finalEvidenceLimit);

  // 7. Map to canonical EvidenceItem[]
  // Deterministic evidenceId: ev_{runId}_{chunkId}
  // STRICT INVARIANT: hybridScore always preserves the canonical RRF score
  const evidenceItems: EvidenceItem[] = selectedCandidates.map((candidate) => ({
    evidenceId: `ev_${state.runId}_${candidate.chunkId}`,
    workspaceId: candidate.workspaceId,
    documentId: candidate.documentId,
    documentVersionId: candidate.documentVersionId,
    chunkId: candidate.chunkId,
    chunkOffset: candidate.chunkOffset,
    text: candidate.content,
    denseScore: candidate.denseSimilarity,
    sparseScore: candidate.sparseRankScore,
    hybridScore: candidate.rrfScore,
    documentTitle: candidate.documentTitle,
    sourceType: candidate.sourceType,
  }));

  return { evidenceItems };
}

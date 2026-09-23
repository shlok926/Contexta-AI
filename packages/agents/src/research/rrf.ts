import {
  DenseChunkCandidate,
  SparseChunkCandidate,
  FusedChunkCandidate,
} from './retrieval.interface';

export const DEFAULT_RRF_K = 60;

export interface RrfFusionOptions {
  readonly k?: number;
  readonly topK?: number;
}

/**
 * Reciprocal Rank Fusion (RRF)
 * Fuses dense vector candidates and sparse FTS candidates into a unified ranked list.
 *
 * Mathematical formulation (ADR-0009 §17):
 *   RRF_Score(d) = sum(1 / (k + Rank_m(d))) for m in {dense, sparse}
 *
 * Rules:
 * 1. 1-based ranks (1 <= Rank_m <= N).
 * 2. If chunk is missing from channel m, its reciprocal rank contribution is 0.
 * 3. Tie-breaking: Primary: rrfScore DESC, Secondary: chunkId ASC (deterministic).
 * 4. Deduplication: Merge dense and sparse candidate metadata.
 */
export function reciprocalRankFusion(
  workspaceId: string,
  denseCandidates: readonly DenseChunkCandidate[],
  sparseCandidates: readonly SparseChunkCandidate[],
  options?: RrfFusionOptions,
): readonly FusedChunkCandidate[] {
  const k = options?.k ?? DEFAULT_RRF_K;
  const topK = options?.topK;

  const candidateMap = new Map<
    string,
    {
      chunkId: string;
      workspaceId: string;
      documentId: string;
      documentVersionId: string;
      chunkOffset: number;
      content: string;
      denseSimilarity?: number;
      sparseRankScore?: number;
      rrfScore: number;
      documentTitle: string;
      sourceType: string;
    }
  >();

  // 1. Process Dense candidates (1-based rank)
  for (let i = 0; i < denseCandidates.length; i++) {
    const candidate = denseCandidates[i];
    const rank = i + 1;
    const scoreContribution = 1 / (k + rank);

    candidateMap.set(candidate.chunkId, {
      chunkId: candidate.chunkId,
      workspaceId,
      documentId: candidate.documentId,
      documentVersionId: candidate.documentVersionId,
      chunkOffset: candidate.chunkOffset,
      content: candidate.content,
      denseSimilarity: candidate.similarity,
      sparseRankScore: undefined,
      rrfScore: scoreContribution,
      documentTitle: candidate.documentTitle,
      sourceType: candidate.sourceType,
    });
  }

  // 2. Process Sparse candidates (1-based rank)
  for (let i = 0; i < sparseCandidates.length; i++) {
    const candidate = sparseCandidates[i];
    const rank = i + 1;
    const scoreContribution = 1 / (k + rank);

    const existing = candidateMap.get(candidate.chunkId);
    if (existing) {
      existing.rrfScore += scoreContribution;
      existing.sparseRankScore = candidate.rankScore;
    } else {
      candidateMap.set(candidate.chunkId, {
        chunkId: candidate.chunkId,
        workspaceId,
        documentId: candidate.documentId,
        documentVersionId: candidate.documentVersionId,
        chunkOffset: candidate.chunkOffset,
        content: candidate.content,
        denseSimilarity: undefined,
        sparseRankScore: candidate.rankScore,
        rrfScore: scoreContribution,
        documentTitle: candidate.documentTitle,
        sourceType: candidate.sourceType,
      });
    }
  }

  // 3. Sort candidates with deterministic tie-breaking
  const fused = Array.from(candidateMap.values()).sort((a, b) => {
    // Primary sort: rrfScore descending
    if (b.rrfScore !== a.rrfScore) {
      return b.rrfScore - a.rrfScore;
    }
    // Secondary sort: chunkId ascending (UUID lexicographical comparison)
    return a.chunkId.localeCompare(b.chunkId);
  });

  // 4. Return topK slice if specified
  if (topK !== undefined && topK > 0) {
    return fused.slice(0, topK);
  }

  return fused;
}

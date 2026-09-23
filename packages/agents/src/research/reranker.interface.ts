/**
 * Cross-Encoder Reranker Interface & Candidate Metadata Types
 * Aligned with ADR-0009 and N3.6 Retrieval Design
 */

export interface RerankCandidateMetadata {
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly chunkOffset: number;
  readonly documentTitle: string;
  readonly sourceType: string;
}

export interface RerankCandidate {
  readonly chunkId: string;
  readonly text: string;
  readonly metadata: RerankCandidateMetadata;
  readonly rrfScore: number;
}

export interface RerankResult {
  readonly chunkId: string;
  readonly rerankScore: number;
}

export interface RerankOptions {
  readonly topK?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface IRerankerProvider {
  rerank(
    query: string,
    candidates: readonly RerankCandidate[],
    options?: RerankOptions,
  ): Promise<readonly RerankResult[]>;
}

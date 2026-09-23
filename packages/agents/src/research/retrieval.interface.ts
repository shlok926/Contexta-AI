/**
 * Retrieval Adapter Interface and Candidate Types
 * Aligned with ADR-0002, ADR-0007, ADR-0009, and N3.6 Retrieval Design
 */

export interface DenseChunkCandidate {
  readonly chunkId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly chunkOffset: number;
  readonly content: string;
  readonly similarity: number;
  readonly documentTitle: string;
  readonly sourceType: string;
}

export interface SparseChunkCandidate {
  readonly chunkId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly chunkOffset: number;
  readonly content: string;
  readonly rankScore: number;
  readonly documentTitle: string;
  readonly sourceType: string;
}

export interface FusedChunkCandidate {
  readonly chunkId: string;
  readonly workspaceId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly chunkOffset: number;
  readonly content: string;
  readonly denseSimilarity?: number;
  readonly sparseRankScore?: number;
  readonly rrfScore: number;
  readonly documentTitle: string;
  readonly sourceType: string;
}

export interface DenseSearchOptions {
  readonly matchThreshold?: number;
  readonly matchCount?: number;
  readonly maxScanTuples?: number;
  readonly signal?: AbortSignal;
}

export interface SparseSearchOptions {
  readonly matchCount?: number;
  readonly signal?: AbortSignal;
}

export interface IRetrievalAdapter {
  searchDense(
    workspaceId: string,
    queryEmbedding: readonly number[],
    options?: DenseSearchOptions,
  ): Promise<readonly DenseChunkCandidate[]>;

  searchSparse(
    workspaceId: string,
    queryText: string,
    options?: SparseSearchOptions,
  ): Promise<readonly SparseChunkCandidate[]>;
}

/**
 * Query Embedding Provider Interface
 * Aligned with ADR-0009 and N3.6 Retrieval Design
 */

export interface EmbeddingOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface IEmbeddingProvider {
  generateQueryEmbedding(
    query: string,
    options?: EmbeddingOptions,
  ): Promise<readonly number[]>;
}

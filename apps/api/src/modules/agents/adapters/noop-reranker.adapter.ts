import { Injectable } from '@nestjs/common';
import type {
  IRerankerProvider,
  RerankCandidate,
  RerankResult,
  RerankOptions,
} from '../../../../../../packages/agents/src/research/reranker.interface.js';

/**
 * NoopRerankerAdapter
 * Test and local development reranker adapter that preserves input RRF ordering.
 */
@Injectable()
export class NoopRerankerAdapter implements IRerankerProvider {
  async rerank(
    _query: string,
    candidates: readonly RerankCandidate[],
    options?: RerankOptions,
  ): Promise<readonly RerankResult[]> {
    if (options?.signal?.aborted) {
      throw new Error('Reranker aborted by signal');
    }

    const topK = options?.topK ?? candidates.length;
    const sliced = candidates.slice(0, topK);

    return sliced.map((candidate, index) => ({
      chunkId: candidate.chunkId,
      rerankScore: 1 - index * 0.01,
    }));
  }
}

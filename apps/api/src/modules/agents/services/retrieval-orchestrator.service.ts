import { Injectable, Optional } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AgentState,
  ResearchNodeOptions,
  RunnableConfigLike,
} from '../../../../../../packages/agents/src/index.js';
import { researchNode } from '../../../../../../packages/agents/src/index.js';
import { SupabaseRetrievalAdapter } from '../adapters/supabase-retrieval.adapter.js';
import { OpenAIEmbeddingAdapter } from '../adapters/openai-embedding.adapter.js';
import { NoopRerankerAdapter } from '../adapters/noop-reranker.adapter.js';
import { getRetrievalConfig, type RetrievalConfig } from '../../../config/retrieval.config.js';

/**
 * RetrievalOrchestratorService
 * NestJS service bridging API infrastructure to the canonical ResearchNode.
 */
@Injectable()
export class RetrievalOrchestratorService {
  private readonly config: RetrievalConfig;
  private readonly embeddingAdapter: OpenAIEmbeddingAdapter;
  private readonly rerankerAdapter: NoopRerankerAdapter;

  constructor() {
    this.config = getRetrievalConfig();
    this.embeddingAdapter = new OpenAIEmbeddingAdapter({
      modelName: this.config.embeddingModel,
      dimensions: this.config.embeddingDimension,
    });
    this.rerankerAdapter = new NoopRerankerAdapter();
  }

  /**
   * Constructs ResearchNodeOptions for a specific request-scoped Supabase client.
   */
  createNodeOptions(supabaseClient: SupabaseClient): ResearchNodeOptions {
    const retrievalAdapter = new SupabaseRetrievalAdapter(supabaseClient);

    return {
      embeddingProvider: this.embeddingAdapter,
      retrievalAdapter,
      rerankerProvider: this.rerankerAdapter,
      denseSimilarityThreshold: this.config.denseSimilarityThreshold,
      denseCandidateLimit: this.config.denseCandidateLimit,
      sparseCandidateLimit: this.config.sparseCandidateLimit,
      maxScanTuples: this.config.hnswMaxScanTuples,
      rrfConstant: this.config.rrfConstant,
      rrfTopCandidates: this.config.rrfTopCandidates,
      finalEvidenceLimit: this.config.finalEvidenceLimit,
      rerankerTimeoutMs: this.config.rerankerTimeoutMs,
    };
  }

  /**
   * Executes researchNode with the provided state and request-scoped Supabase client.
   */
  async executeResearch(
    state: AgentState,
    supabaseClient: SupabaseClient,
    config?: RunnableConfigLike,
  ): Promise<Partial<AgentState>> {
    const options = this.createNodeOptions(supabaseClient);
    return await researchNode(state, config, options);
  }
}

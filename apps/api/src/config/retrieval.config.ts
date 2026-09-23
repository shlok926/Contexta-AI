import { z } from 'zod';

export const RetrievalConfigSchema = z.object({
  embeddingModel: z.string().default('text-embedding-3-small'),
  embeddingDimension: z.literal(1536).default(1536),
  denseCandidateLimit: z.number().int().min(10).max(200).default(60),
  denseSimilarityThreshold: z.number().min(0.0).max(1.0).default(0.3),
  hnswMaxScanTuples: z.number().int().min(1000).max(100000).default(20000),
  sparseCandidateLimit: z.number().int().min(10).max(200).default(60),
  rrfConstant: z.literal(60).default(60),
  rrfTopCandidates: z.number().int().min(5).max(50).default(20),
  finalEvidenceLimit: z.number().int().min(1).max(20).default(5),
  rerankerProvider: z.enum(['cohere', 'bge', 'noop']).default('noop'),
  rerankerTimeoutMs: z.number().int().min(50).max(2000).default(150),
  dbTimeoutMs: z.number().int().min(500).max(10000).default(2000),
});

export type RetrievalConfig = z.infer<typeof RetrievalConfigSchema>;

export function getRetrievalConfig(env: NodeJS.ProcessEnv = process.env): RetrievalConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const defaultProvider = nodeEnv === 'production' ? 'cohere' : 'noop';

  const rawProvider = env.RERANKER_PROVIDER || defaultProvider;

  // Strict production enforcement: 'noop' reranker is prohibited in production
  if (nodeEnv === 'production' && rawProvider === 'noop') {
    throw new Error(
      'Configuration Error: Production environment requires a real cross-encoder reranker provider (cohere or bge); noop is strictly prohibited in production.',
    );
  }

  const parsed = {
    embeddingModel: env.RETRIEVAL_EMBEDDING_MODEL,
    embeddingDimension: env.RETRIEVAL_EMBEDDING_DIM ? Number(env.RETRIEVAL_EMBEDDING_DIM) : 1536,
    denseCandidateLimit: env.RETRIEVAL_DENSE_CANDIDATE_LIMIT
      ? Number(env.RETRIEVAL_DENSE_CANDIDATE_LIMIT)
      : 60,
    denseSimilarityThreshold: env.RETRIEVAL_DENSE_SIMILARITY_THRESHOLD
      ? Number(env.RETRIEVAL_DENSE_SIMILARITY_THRESHOLD)
      : 0.3,
    hnswMaxScanTuples: env.RETRIEVAL_HNSW_MAX_SCAN_TUPLES
      ? Number(env.RETRIEVAL_HNSW_MAX_SCAN_TUPLES)
      : 20000,
    sparseCandidateLimit: env.RETRIEVAL_SPARSE_CANDIDATE_LIMIT
      ? Number(env.RETRIEVAL_SPARSE_CANDIDATE_LIMIT)
      : 60,
    rrfConstant: 60 as const,
    rrfTopCandidates: env.RETRIEVAL_RRF_TOP_CANDIDATES
      ? Number(env.RETRIEVAL_RRF_TOP_CANDIDATES)
      : 20,
    finalEvidenceLimit: env.RETRIEVAL_FINAL_EVIDENCE_LIMIT
      ? Number(env.RETRIEVAL_FINAL_EVIDENCE_LIMIT)
      : 5,
    rerankerProvider: rawProvider as 'cohere' | 'bge' | 'noop',
    rerankerTimeoutMs: env.RETRIEVAL_RERANKER_TIMEOUT_MS
      ? Number(env.RETRIEVAL_RERANKER_TIMEOUT_MS)
      : 150,
    dbTimeoutMs: env.RETRIEVAL_DB_TIMEOUT_MS ? Number(env.RETRIEVAL_DB_TIMEOUT_MS) : 2000,
  };

  return RetrievalConfigSchema.parse(parsed);
}

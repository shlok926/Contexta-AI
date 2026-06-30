export const THRESHOLDS = {
  // Citation match confidence threshold
  // Can be overridden via env var in staging/tuning environments
  CITATION_CONFIDENCE_GATE: process.env.CITATION_CONFIDENCE_GATE
    ? parseFloat(process.env.CITATION_CONFIDENCE_GATE)
    : 0.75,

  // Research retrieval minimum score
  RETRIEVAL_MIN_SCORE: process.env.RETRIEVAL_MIN_SCORE
    ? parseFloat(process.env.RETRIEVAL_MIN_SCORE)
    : 0.6,
    
  // Hybrid Search Tuning (Phase 2)
  HYBRID_FUSION_WEIGHT_VECTOR: process.env.HYBRID_FUSION_WEIGHT_VECTOR
    ? parseFloat(process.env.HYBRID_FUSION_WEIGHT_VECTOR)
    : 0.7, // 70% vector, 30% keyword by default

  HYBRID_RERANKER_THRESHOLD: process.env.HYBRID_RERANKER_THRESHOLD
    ? parseFloat(process.env.HYBRID_RERANKER_THRESHOLD)
    : 0.5,
};

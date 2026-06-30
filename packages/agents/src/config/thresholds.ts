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
};

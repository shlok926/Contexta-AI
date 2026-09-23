import { getRetrievalConfig } from '../../src/config/retrieval.config.js';

describe('N3.6 Retrieval Configuration & Production Reranker Enforcement', () => {
  it('strictly rejects noop reranker in production environment', () => {
    expect(() => {
      getRetrievalConfig({
        NODE_ENV: 'production',
        RERANKER_PROVIDER: 'noop',
      });
    }).toThrow(/Production environment requires a real cross-encoder reranker provider/);
  });

  it('accepts cohere reranker in production environment', () => {
    const config = getRetrievalConfig({
      NODE_ENV: 'production',
      RERANKER_PROVIDER: 'cohere',
    });
    expect(config.rerankerProvider).toBe('cohere');
  });

  it('accepts bge reranker in production environment', () => {
    const config = getRetrievalConfig({
      NODE_ENV: 'production',
      RERANKER_PROVIDER: 'bge',
    });
    expect(config.rerankerProvider).toBe('bge');
  });

  it('defaults to cohere in production environment when not explicitly provided', () => {
    const config = getRetrievalConfig({
      NODE_ENV: 'production',
    });
    expect(config.rerankerProvider).toBe('cohere');
  });

  it('permits noop reranker in development and test environments', () => {
    const devConfig = getRetrievalConfig({
      NODE_ENV: 'development',
      RERANKER_PROVIDER: 'noop',
    });
    expect(devConfig.rerankerProvider).toBe('noop');

    const testConfig = getRetrievalConfig({
      NODE_ENV: 'test',
      RERANKER_PROVIDER: 'noop',
    });
    expect(testConfig.rerankerProvider).toBe('noop');
  });

  it('validates default tunable parameters according to ADR-0009', () => {
    const config = getRetrievalConfig({
      NODE_ENV: 'test',
    });

    expect(config.embeddingModel).toBe('text-embedding-3-small');
    expect(config.embeddingDimension).toBe(1536);
    expect(config.denseCandidateLimit).toBe(60);
    expect(config.denseSimilarityThreshold).toBe(0.3);
    expect(config.hnswMaxScanTuples).toBe(20000);
    expect(config.sparseCandidateLimit).toBe(60);
    expect(config.rrfConstant).toBe(60);
    expect(config.rrfTopCandidates).toBe(20);
    expect(config.finalEvidenceLimit).toBe(5);
    expect(config.rerankerTimeoutMs).toBe(150);
    expect(config.dbTimeoutMs).toBe(2000);
  });
});

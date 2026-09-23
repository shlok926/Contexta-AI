import { getDraftResponseConfig } from '../../src/config/draft-response.config.js';

describe('N3.7 DraftResponse Configuration & Provider Enforcement', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('strictly rejects mock provider in production environment', () => {
    expect(() => {
      getDraftResponseConfig({
        NODE_ENV: 'production',
        DRAFT_RESPONSE_PROVIDER: 'mock',
      });
    }).toThrow(/Production environment requires a real LLM provider/);
  });

  it('accepts openai provider in production environment', () => {
    const config = getDraftResponseConfig({
      NODE_ENV: 'production',
      DRAFT_RESPONSE_PROVIDER: 'openai',
      DRAFT_RESPONSE_MODEL: 'gpt-4o',
    });

    expect(config.provider).toBe('openai');
    expect(config.modelName).toBe('gpt-4o');
    expect(config.temperature).toBe(0.0);
  });

  it('defaults to mock provider in test environment', () => {
    const config = getDraftResponseConfig({
      NODE_ENV: 'test',
    });

    expect(config.provider).toBe('mock');
  });

  it('validates tunable parameters according to design', () => {
    const config = getDraftResponseConfig({
      NODE_ENV: 'development',
      DRAFT_RESPONSE_TIMEOUT_MS: '8000',
    });

    expect(config.timeoutMs).toBe(8000);
    expect(config.modelName).toBe('gpt-4o-mini');
  });
});

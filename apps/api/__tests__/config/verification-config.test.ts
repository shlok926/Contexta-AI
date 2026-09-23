import { getVerificationConfig } from '../../src/config/verification.config.js';

describe('N3.8-C4 Verification Configuration & Provider Enforcement', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('C4-001: Valid configuration accepted with default values', () => {
    const config = getVerificationConfig({
      NODE_ENV: 'development',
    });

    expect(config.provider).toBe('openai');
    expect(config.modelName).toBe('gpt-4o-mini');
    expect(config.temperature).toBe(0.0);
    expect(config.timeoutMs).toBe(5000);
  });

  it('C4-002: Rejects mock provider in production environment safely', () => {
    expect(() => {
      getVerificationConfig({
        NODE_ENV: 'production',
        CITATION_VERIFICATION_PROVIDER: 'mock',
      });
    }).toThrow(/Production environment requires a real LLM provider/);
  });

  it('C4-003: Invalid timeout or model configuration rejected safely', () => {
    // timeoutMs below min (500)
    expect(() => {
      getVerificationConfig({
        NODE_ENV: 'development',
        CITATION_VERIFICATION_TIMEOUT_MS: '100',
      });
    }).toThrow();

    // timeoutMs above max (30000)
    expect(() => {
      getVerificationConfig({
        NODE_ENV: 'development',
        CITATION_VERIFICATION_TIMEOUT_MS: '50000',
      });
    }).toThrow();
  });

  it('accepts openai provider in production environment', () => {
    const config = getVerificationConfig({
      NODE_ENV: 'production',
      CITATION_VERIFICATION_PROVIDER: 'openai',
      CITATION_VERIFICATION_MODEL: 'gpt-4o',
      CITATION_VERIFICATION_TIMEOUT_MS: '10000',
    });

    expect(config.provider).toBe('openai');
    expect(config.modelName).toBe('gpt-4o');
    expect(config.temperature).toBe(0.0);
    expect(config.timeoutMs).toBe(10000);
  });

  it('defaults to mock provider in test environment', () => {
    const config = getVerificationConfig({
      NODE_ENV: 'test',
    });

    expect(config.provider).toBe('mock');
  });
});

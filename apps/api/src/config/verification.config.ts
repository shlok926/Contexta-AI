import { z } from 'zod';

export const VerificationConfigSchema = z.object({
  modelName: z.string().default('gpt-4o-mini'),
  temperature: z.literal(0.0).default(0.0),
  timeoutMs: z.number().int().min(500).max(30000).default(5000),
  provider: z.enum(['openai', 'mock']).default('openai'),
});

export type VerificationConfig = z.infer<typeof VerificationConfigSchema>;

export function getVerificationConfig(env: NodeJS.ProcessEnv = process.env): VerificationConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const defaultProvider = nodeEnv === 'test' ? 'mock' : 'openai';
  const rawProvider = env.CITATION_VERIFICATION_PROVIDER || defaultProvider;

  // Strict production enforcement: 'mock' provider is prohibited in production
  if (nodeEnv === 'production' && rawProvider === 'mock') {
    throw new Error(
      'Configuration Error: Production environment requires a real LLM provider (openai); mock is strictly prohibited in production.',
    );
  }

  const parsed = {
    modelName: env.CITATION_VERIFICATION_MODEL ?? 'gpt-4o-mini',
    temperature: 0.0 as const,
    timeoutMs: env.CITATION_VERIFICATION_TIMEOUT_MS ? Number(env.CITATION_VERIFICATION_TIMEOUT_MS) : 5000,
    provider: rawProvider as 'openai' | 'mock',
  };

  return VerificationConfigSchema.parse(parsed);
}

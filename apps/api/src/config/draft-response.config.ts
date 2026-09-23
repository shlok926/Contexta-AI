import { z } from 'zod';

export const DraftResponseConfigSchema = z.object({
  modelName: z.string().default('gpt-4o-mini'),
  temperature: z.literal(0.0).default(0.0),
  timeoutMs: z.number().int().min(500).max(30000).default(5000),
  provider: z.enum(['openai', 'mock']).default('openai'),
});

export type DraftResponseConfig = z.infer<typeof DraftResponseConfigSchema>;

export function getDraftResponseConfig(env: NodeJS.ProcessEnv = process.env): DraftResponseConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const defaultProvider = nodeEnv === 'test' ? 'mock' : 'openai';
  const rawProvider = env.DRAFT_RESPONSE_PROVIDER || defaultProvider;

  // Strict production enforcement: 'mock' provider is prohibited in production
  if (nodeEnv === 'production' && rawProvider === 'mock') {
    throw new Error(
      'Configuration Error: Production environment requires a real LLM provider (openai); mock is strictly prohibited in production.',
    );
  }

  const parsed = {
    modelName: env.DRAFT_RESPONSE_MODEL ?? 'gpt-4o-mini',
    temperature: 0.0 as const,
    timeoutMs: env.DRAFT_RESPONSE_TIMEOUT_MS ? Number(env.DRAFT_RESPONSE_TIMEOUT_MS) : 5000,
    provider: rawProvider as 'openai' | 'mock',
  };

  return DraftResponseConfigSchema.parse(parsed);
}

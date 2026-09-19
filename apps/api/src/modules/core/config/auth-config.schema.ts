import { z } from 'zod';

export const AuthConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    SUPABASE_URL: z
      .string({
        required_error: 'SUPABASE_URL is required',
      })
      .url('SUPABASE_URL must be a valid URL'),
    SUPABASE_ANON_KEY: z
      .string({
        required_error: 'SUPABASE_ANON_KEY is required',
      })
      .min(10, 'SUPABASE_ANON_KEY must be at least 10 characters'),
    JWT_VERIFICATION_PROFILE: z.enum(['symmetric', 'asymmetric']).optional(),
    JWT_VERIFICATION_STRATEGY: z.enum(['symmetric', 'asymmetric']).optional(),
    SUPABASE_JWT_SECRET: z.string().optional(),
    SUPABASE_JWKS_URL: z.string().url('SUPABASE_JWKS_URL must be a valid URL').optional().or(z.literal('')),
    SUPABASE_JWT_PUBLIC_KEY: z
      .string()
      .min(20, 'SUPABASE_JWT_PUBLIC_KEY must be at least 20 characters')
      .optional()
      .or(z.literal('')),
    SUPABASE_JWT_ISSUER: z.string().optional(),
    SUPABASE_JWT_AUDIENCE: z.string().default('authenticated'),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(10).optional().or(z.literal('')),
    ENABLE_PRIVILEGED_EXECUTION: z
      .preprocess((val) => {
        if (val === undefined || val === null || val === '') {
          return false;
        }
        if (typeof val === 'boolean') {
          return val;
        }
        if (typeof val === 'string') {
          const lower = val.trim().toLowerCase();
          if (lower === 'true' || lower === '1') return true;
          if (lower === 'false' || lower === '0') return false;
          return val;
        }
        return val;
      }, z.boolean({ invalid_type_error: 'ENABLE_PRIVILEGED_EXECUTION must be a boolean (true/false/1/0)' }))
      .default(false),
    CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),
  })
  .superRefine((data, ctx) => {
    const strategy = data.JWT_VERIFICATION_PROFILE || data.JWT_VERIFICATION_STRATEGY || 'symmetric';

    if (strategy === 'symmetric') {
      if (!data.SUPABASE_JWT_SECRET || data.SUPABASE_JWT_SECRET.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'SUPABASE_JWT_SECRET is required when verification strategy is symmetric.',
          path: ['SUPABASE_JWT_SECRET'],
        });
      } else if (data.SUPABASE_JWT_SECRET.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'SUPABASE_JWT_SECRET must be at least 32 characters for symmetric verification.',
          path: ['SUPABASE_JWT_SECRET'],
        });
      }
    }

    if (strategy === 'asymmetric') {
      const hasJwks = Boolean(data.SUPABASE_JWKS_URL && data.SUPABASE_JWKS_URL.trim().length > 0);
      const hasPublicKey = Boolean(data.SUPABASE_JWT_PUBLIC_KEY && data.SUPABASE_JWT_PUBLIC_KEY.trim().length > 0);

      if (!hasJwks && !hasPublicKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Either SUPABASE_JWKS_URL or SUPABASE_JWT_PUBLIC_KEY is required when verification strategy is asymmetric.',
          path: ['SUPABASE_JWKS_URL'],
        });
      }
    }

    if (data.ENABLE_PRIVILEGED_EXECUTION) {
      if (!data.SUPABASE_SERVICE_ROLE_KEY || data.SUPABASE_SERVICE_ROLE_KEY.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'SUPABASE_SERVICE_ROLE_KEY is required when ENABLE_PRIVILEGED_EXECUTION is true.',
          path: ['SUPABASE_SERVICE_ROLE_KEY'],
        });
      }
    }
  });

export type AuthConfig = z.infer<typeof AuthConfigSchema>;

/**
 * Validates and transforms raw environment configuration.
 * Fails closed by throwing a formatted error on any validation violation,
 * ensuring secret values are never leaked in error messages.
 */
export function validateAuthConfig(config: Record<string, unknown>): AuthConfig {
  const result = AuthConfigSchema.safeParse(config);

  if (!result.success) {
    const errorMessages = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new Error(`[Configuration Error] Invalid environment configuration:\n${errorMessages}`);
  }

  return result.data;
}

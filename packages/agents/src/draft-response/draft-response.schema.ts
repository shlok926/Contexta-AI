import { z } from 'zod';
import type { ExtractedClaim } from '../state';

/**
 * ExtractedClaimSchema
 * Runtime validation schema for atomic claims extracted from a synthesized draft response.
 * Aligned with frozen ExtractedClaim contract in state.ts (ADR-0003 / ADR-0005).
 */
export const ExtractedClaimSchema = z.object({
  claimId: z.string().min(1),
  claimText: z.string().min(1),
  citedChunkIds: z.array(z.string().min(1)),
}).strict();

/**
 * Canonical DraftResponse interface.
 * Encapsulates the synthesized answer prose and its candidate atomic claims.
 */
export interface DraftResponse {
  readonly answer: string;
  readonly extractedClaims: readonly ExtractedClaim[];
}

/**
 * DraftResponseSchema
 * Runtime validation schema for structured draft response generation.
 * Enforces non-empty answer string and strict array of ExtractedClaim objects.
 */
export const DraftResponseSchema = z.object({
  answer: z.string().min(1),
  extractedClaims: z.array(ExtractedClaimSchema),
}).strict();

/**
 * Type-safe helper to validate arbitrary input against DraftResponseSchema.
 */
export function validateDraftResponse(data: unknown): DraftResponse {
  return DraftResponseSchema.parse(data) as DraftResponse;
}

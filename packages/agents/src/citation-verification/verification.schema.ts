import { z } from 'zod';
import { CANONICAL_VERIFICATION_STATUSES } from './verification.types';
import type {
  VerificationEvidenceItem,
  VerificationClaimInput,
  VerificationRequest,
  VerificationClaimEvaluation,
  VerificationProviderResponse,
} from './verification.types';

/**
 * CanonicalVerificationStatusSchema
 * Strict enum validation for the 6 ADR-0003 verification statuses.
 */
export const CanonicalVerificationStatusSchema = z.enum(CANONICAL_VERIFICATION_STATUSES);

/**
 * VerificationEvidenceItemSchema
 * Runtime validation for sanitized model-facing evidence chunks.
 */
export const VerificationEvidenceItemSchema = z.object({
  chunkId: z.string().min(1),
  documentTitle: z.string().min(1),
  text: z.string().min(1),
  sourceType: z.string().optional(),
  chunkOffset: z.number().int().nonnegative().optional(),
}).strict();

/**
 * VerificationClaimInputSchema
 * Runtime validation for atomic claims to verify.
 */
export const VerificationClaimInputSchema = z.object({
  claimId: z.string().min(1),
  claimText: z.string().min(1),
  citedChunkIds: z.array(z.string().min(1)),
}).strict();

/**
 * VerificationRequestSchema
 * Runtime validation for provider verification requests.
 */
export const VerificationRequestSchema = z.object({
  claims: z.array(VerificationClaimInputSchema).min(1),
  candidateEvidence: z.array(VerificationEvidenceItemSchema),
  correlationId: z.string().optional(),
}).strict();

/**
 * VerificationClaimEvaluationSchema
 * Strict Zod validation schema for individual claim entailment decisions.
 * Enforces:
 * 1. .strict() - rejects any unauthorized injected keys (e.g. thinking, bypass_gate).
 * 2. entailmentScore bounded between 0.0 and 1.0.
 * 3. explanation bounded string (max 500 chars).
 * 4. citedChunkIds array of non-empty strings.
 * 5. optional conflictingChunkIds array of non-empty strings.
 */
export const VerificationClaimEvaluationSchema = z.object({
  claimId: z.string().min(1),
  status: CanonicalVerificationStatusSchema,
  entailmentScore: z.number().min(0).max(1),
  citedChunkIds: z.array(z.string().min(1)),
  conflictingChunkIds: z.array(z.string().min(1)).optional(),
  explanation: z.string().min(1).max(500),
}).strict();

/**
 * VerificationProviderResponseSchema
 * Runtime validation for the aggregate provider response.
 */
export const VerificationProviderResponseSchema = z.object({
  evaluations: z.array(VerificationClaimEvaluationSchema),
}).strict();

/**
 * Stage1ClaimEvaluationSchema
 * Runtime validation for deterministic pre-filter evaluations.
 */
export const Stage1ClaimEvaluationSchema = z.object({
  claimId: z.string().min(1),
  status: z.enum(['STAGE_1_PASSED', 'CONTRADICTED', 'INSUFFICIENT_EVIDENCE']),
  validCitedChunkIds: z.array(z.string().min(1)),
  failureReason: z.string().optional(),
}).strict();

/**
 * Stage1ResultSchema
 * Runtime validation for deterministic pre-filter batch result.
 */
export const Stage1ResultSchema = z.object({
  evaluations: z.array(Stage1ClaimEvaluationSchema),
}).strict();

/**
 * validateVerificationProviderResponse
 * Helper function to validate arbitrary provider JSON output against VerificationProviderResponseSchema.
 */
export function validateVerificationProviderResponse(data: unknown): VerificationProviderResponse {
  return VerificationProviderResponseSchema.parse(data) as VerificationProviderResponse;
}

/**
 * validateVerificationRequest
 * Helper function to validate input request payloads.
 */
export function validateVerificationRequest(data: unknown): VerificationRequest {
  return VerificationRequestSchema.parse(data) as VerificationRequest;
}

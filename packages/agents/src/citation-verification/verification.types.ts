import type { VerificationStatus } from '../state';
export type { VerificationStatus };

/**
 * CANONICAL_VERIFICATION_STATUSES
 * The 6 authoritative entailment verification statuses defined by ADR-0003 §13.
 */
export const CANONICAL_VERIFICATION_STATUSES = [
  'SUPPORTED',
  'PARTIALLY_SUPPORTED',
  'CONTRADICTED',
  'CONFLICTING_EVIDENCE',
  'INSUFFICIENT_EVIDENCE',
  'VERIFICATION_FAILED',
] as const;

export type CanonicalVerificationStatus = (typeof CANONICAL_VERIFICATION_STATUSES)[number];

/**
 * VerificationEvidenceItem
 * Sanitized, model-facing representation of an evidence item passed to the verifier.
 * Stripped of internal retrieval scoring (denseScore, sparseScore, hybridScore)
 * and multi-tenant DB credentials (workspaceId, documentVersionId) per ADR-0003 §12.
 */
export interface VerificationEvidenceItem {
  readonly chunkId: string;
  readonly documentTitle: string;
  readonly text: string;
  readonly sourceType?: string;
  readonly chunkOffset?: number;
}

/**
 * VerificationClaimInput
 * Input representation of an atomic claim for verification.
 * Adheres to the frozen ExtractedClaim contract in state.ts.
 */
export interface VerificationClaimInput {
  readonly claimId: string;
  readonly claimText: string;
  readonly citedChunkIds: readonly string[];
}

/**
 * VerificationRequest
 * Formal input payload supplied to IVerificationProvider.
 * Encapsulates the claims to verify against the tenant-safe evidence package.
 */
export interface VerificationRequest {
  readonly claims: readonly VerificationClaimInput[];
  readonly candidateEvidence: readonly VerificationEvidenceItem[];
  readonly correlationId?: string;
}

/**
 * VerificationClaimEvaluation
 * Structured verification decision for a single claim emitted by the Stage 2 LLM verifier.
 * Strictly constrained by VerificationClaimEvaluationSchema.
 */
export interface VerificationClaimEvaluation {
  readonly claimId: string;
  readonly status: CanonicalVerificationStatus;
  readonly entailmentScore: number;
  readonly citedChunkIds: readonly string[];
  readonly conflictingChunkIds?: readonly string[];
  readonly explanation: string;
}

/**
 * VerificationProviderResponse
 * Canonical response payload from an IVerificationProvider.
 */
export interface VerificationProviderResponse {
  readonly evaluations: readonly VerificationClaimEvaluation[];
}

/**
 * Stage1EvaluationStatus
 * Possible outcomes of the Stage 1 Deterministic Safety Pre-Filter.
 * Invariant: Stage 1 can NEVER mark a claim as SUPPORTED.
 */
export type Stage1EvaluationStatus =
  | 'STAGE_1_PASSED'
  | 'CONTRADICTED'
  | 'INSUFFICIENT_EVIDENCE';

/**
 * Stage1ClaimEvaluation
 * Deterministic pre-filter decision for an individual claim.
 */
export interface Stage1ClaimEvaluation {
  readonly claimId: string;
  readonly status: Stage1EvaluationStatus;
  readonly validCitedChunkIds: readonly string[];
  readonly failureReason?: string;
}

/**
 * Stage1Result
 * Aggregated output of the Stage 1 Deterministic Safety Pre-Filter.
 */
export interface Stage1Result {
  readonly evaluations: readonly Stage1ClaimEvaluation[];
}

/**
 * Normalized ClaimVerificationResult
 * Aligned with ADR-0003 §13 Normalized Verification Result Model.
 */
export interface NormalizedClaimVerificationResult {
  readonly claimId: string;
  readonly claimText: string;
  readonly status: CanonicalVerificationStatus;
  readonly entailmentScore?: number;
  readonly citedChunkIds: readonly string[];
  readonly conflictingChunkIds?: readonly string[];
  readonly explanation: string;
  readonly stage1Passed: boolean;
  readonly stage2Evaluated: boolean;
  readonly isSafeToPresent: boolean;
  readonly failureReason?: string;
}

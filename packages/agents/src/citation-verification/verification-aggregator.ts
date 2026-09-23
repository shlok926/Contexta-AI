import type { VerificationResult } from '../state';
import { THRESHOLDS } from '../config/thresholds';

export type VerificationRouteTarget = 'ReportNode' | 'UncertaintyNode' | 'VerificationFailedNode';

export interface VerificationAggregationSummary {
  readonly totalClaims: number;
  readonly supportedCount: number;
  readonly partiallySupportedCount: number;
  readonly contradictedCount: number;
  readonly insufficientCount: number;
  readonly conflictingCount: number;
  readonly failedCount: number;
}

export interface VerificationAggregation {
  readonly route: VerificationRouteTarget;
  readonly verificationScore: number | null;
  readonly isFullyVerified: boolean;
  readonly hasOperationalFailure: boolean;
  readonly hasUnresolvedClaims: boolean;
  readonly summary: VerificationAggregationSummary;
}

/**
 * aggregateVerificationResults (N3.8-C6)
 *
 * Pure, side-effect-free deterministic aggregator that evaluates claim-level
 * VerificationResult[] items and computes the response-level verification decision.
 *
 * Governing Rules (ADR-0003 §11, §13, §14 & ADR-0005 §8, §14):
 * 1. Zero Claims (results = []):
 *    - verificationScore = 0.0
 *    - route = 'UncertaintyNode'
 * 2. Operational Failure / Invalid Score (Any claim has status === 'VERIFICATION_FAILED' or invalid score):
 *    - hasOperationalFailure = true
 *    - verificationScore = null (operational failures are not conflated with factual scores)
 *    - route = 'VerificationFailedNode'
 * 3. Fully Verified Response (100% of claims are SUPPORTED and EVERY individual claim has entailmentScore >= confidenceGate):
 *    - isFullyVerified = true
 *    - route = 'ReportNode'
 * 4. Unresolved / Partial / Contradicted / Conflicting / Sub-threshold Response:
 *    - Any claim is PARTIALLY_SUPPORTED, CONTRADICTED, INSUFFICIENT_EVIDENCE, CONFLICTING_EVIDENCE, or individual score < gate
 *    - hasUnresolvedClaims = true
 *    - route = 'UncertaintyNode'
 */
export function aggregateVerificationResults(
  results?: readonly VerificationResult[] | null,
  confidenceGate: number = THRESHOLDS.CITATION_CONFIDENCE_GATE,
): VerificationAggregation {
  if (!results || results.length === 0) {
    return {
      route: 'UncertaintyNode',
      verificationScore: 0.0,
      isFullyVerified: false,
      hasOperationalFailure: false,
      hasUnresolvedClaims: true,
      summary: {
        totalClaims: 0,
        supportedCount: 0,
        partiallySupportedCount: 0,
        contradictedCount: 0,
        insufficientCount: 0,
        conflictingCount: 0,
        failedCount: 0,
      },
    };
  }

  let supportedCount = 0;
  let partiallySupportedCount = 0;
  let contradictedCount = 0;
  let insufficientCount = 0;
  let conflictingCount = 0;
  let failedCount = 0;
  let scoreSum = 0;
  let hasInvalidScore = false;
  let allIndividualClaimsMeetGate = true;

  for (const res of results) {
    if (res.status === 'VERIFICATION_FAILED') {
      failedCount++;
      continue;
    }

    const score = res.entailmentScore;
    if (
      score !== undefined &&
      (typeof score !== 'number' || Number.isNaN(score) || !Number.isFinite(score) || score < 0 || score > 1)
    ) {
      hasInvalidScore = true;
      failedCount++;
      continue;
    }

    switch (res.status) {
      case 'SUPPORTED': {
        supportedCount++;
        const effectiveScore = score ?? 1.0;
        scoreSum += effectiveScore;
        if (effectiveScore < confidenceGate) {
          allIndividualClaimsMeetGate = false;
        }
        break;
      }
      case 'PARTIALLY_SUPPORTED': {
        partiallySupportedCount++;
        const effectiveScore = score ?? 0.5;
        scoreSum += effectiveScore;
        allIndividualClaimsMeetGate = false;
        break;
      }
      case 'CONTRADICTED': {
        contradictedCount++;
        const effectiveScore = score ?? 0.0;
        scoreSum += effectiveScore;
        allIndividualClaimsMeetGate = false;
        break;
      }
      case 'INSUFFICIENT_EVIDENCE': {
        insufficientCount++;
        const effectiveScore = score ?? 0.0;
        scoreSum += effectiveScore;
        allIndividualClaimsMeetGate = false;
        break;
      }
      case 'CONFLICTING_EVIDENCE': {
        conflictingCount++;
        const effectiveScore = score ?? 0.0;
        scoreSum += effectiveScore;
        allIndividualClaimsMeetGate = false;
        break;
      }
      default: {
        insufficientCount++;
        const effectiveScore = score ?? 0.0;
        scoreSum += effectiveScore;
        allIndividualClaimsMeetGate = false;
        break;
      }
    }
  }

  const totalClaims = results.length;
  const summary: VerificationAggregationSummary = {
    totalClaims,
    supportedCount,
    partiallySupportedCount,
    contradictedCount,
    insufficientCount,
    conflictingCount,
    failedCount,
  };

  // Rule 2: Operational verification failure or invalid score takes precedence (fail closed)
  if (failedCount > 0 || hasInvalidScore) {
    return {
      route: 'VerificationFailedNode',
      verificationScore: null,
      isFullyVerified: false,
      hasOperationalFailure: true,
      hasUnresolvedClaims: false,
      summary,
    };
  }

  // Rule 3: Factual score calculation & telemetry
  const rawScore = scoreSum / totalClaims;
  const verificationScore = Math.round(rawScore * 10000) / 10000;

  // Rule 4: ReportNode authorization requires 100% SUPPORTED AND every claim >= confidenceGate
  const allSupported = supportedCount === totalClaims;

  if (allSupported && allIndividualClaimsMeetGate) {
    return {
      route: 'ReportNode',
      verificationScore,
      isFullyVerified: true,
      hasOperationalFailure: false,
      hasUnresolvedClaims: false,
      summary,
    };
  }

  return {
    route: 'UncertaintyNode',
    verificationScore,
    isFullyVerified: false,
    hasOperationalFailure: false,
    hasUnresolvedClaims: true,
    summary,
  };
}

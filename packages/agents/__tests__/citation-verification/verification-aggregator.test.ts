import { describe, it, expect } from '@jest/globals';
import { aggregateVerificationResults } from '../../src/citation-verification/verification-aggregator';
import type { VerificationResult } from '../../src/state';

describe('N3.8-C6: Verification Aggregator (Pure Response-Level Logic)', () => {
  const createResult = (
    claimId: string,
    status: VerificationResult['status'],
    entailmentScore?: number,
  ): VerificationResult => ({
    claimId,
    claimText: `Claim text for ${claimId}`,
    status,
    citedChunkIds: ['chunk-1'],
    entailmentScore,
    stage1Passed: status !== 'CONTRADICTED' && status !== 'INSUFFICIENT_EVIDENCE',
    stage2Evaluated: status !== 'VERIFICATION_FAILED' && status !== 'CONTRADICTED' && status !== 'INSUFFICIENT_EVIDENCE',
  });

  // =========================================================================
  // Zero Claims
  // =========================================================================
  it('aggregates zero claims into UncertaintyNode with score 0.0', () => {
    const agg = aggregateVerificationResults([]);
    expect(agg.route).toBe('UncertaintyNode');
    expect(agg.verificationScore).toBe(0.0);
    expect(agg.isFullyVerified).toBe(false);
    expect(agg.hasOperationalFailure).toBe(false);
    expect(agg.hasUnresolvedClaims).toBe(true);
    expect(agg.summary.totalClaims).toBe(0);
  });

  // =========================================================================
  // GATE A: Per-Claim Confidence Gate & Masking Prevention
  // =========================================================================
  it('Gate A.1: single SUPPORTED claim at 0.75 boundary routes to ReportNode', () => {
    const results = [createResult('c1', 'SUPPORTED', 0.75)];
    const agg = aggregateVerificationResults(results, 0.75);

    expect(agg.route).toBe('ReportNode');
    expect(agg.verificationScore).toBe(0.75);
    expect(agg.isFullyVerified).toBe(true);
  });

  it('Gate A.2: single SUPPORTED claim just below threshold (0.74) routes to UncertaintyNode', () => {
    const results = [createResult('c1', 'SUPPORTED', 0.74)];
    const agg = aggregateVerificationResults(results, 0.75);

    expect(agg.route).toBe('UncertaintyNode');
    expect(agg.verificationScore).toBe(0.74);
    expect(agg.isFullyVerified).toBe(false);
    expect(agg.hasUnresolvedClaims).toBe(true);
  });

  it('Gate A.3: 1.00 + 0.50 (Mean 0.75) routes to UncertaintyNode (prevents masking)', () => {
    const results = [
      createResult('c1', 'SUPPORTED', 1.00),
      createResult('c2', 'SUPPORTED', 0.50),
    ];
    const agg = aggregateVerificationResults(results, 0.75);

    expect(agg.route).toBe('UncertaintyNode');
    expect(agg.verificationScore).toBe(0.75);
    expect(agg.isFullyVerified).toBe(false);
    expect(agg.hasUnresolvedClaims).toBe(true);
  });

  it('Gate A.4: 1.00 + 0.74 (Mean 0.87) routes to UncertaintyNode (prevents masking)', () => {
    const results = [
      createResult('c1', 'SUPPORTED', 1.00),
      createResult('c2', 'SUPPORTED', 0.74),
    ];
    const agg = aggregateVerificationResults(results, 0.75);

    expect(agg.route).toBe('UncertaintyNode');
    expect(agg.verificationScore).toBe(0.87);
    expect(agg.isFullyVerified).toBe(false);
    expect(agg.hasUnresolvedClaims).toBe(true);
  });

  it('Gate A.5: 1.00 + 0.00 (Mean 0.50) routes to UncertaintyNode', () => {
    const results = [
      createResult('c1', 'SUPPORTED', 1.00),
      createResult('c2', 'SUPPORTED', 0.00),
    ];
    const agg = aggregateVerificationResults(results, 0.75);

    expect(agg.route).toBe('UncertaintyNode');
    expect(agg.verificationScore).toBe(0.50);
    expect(agg.isFullyVerified).toBe(false);
  });

  it('Gate A.6: 0.76 + 0.74 (Mean 0.75) routes to UncertaintyNode because of sub-threshold claim', () => {
    const results = [
      createResult('c1', 'SUPPORTED', 0.76),
      createResult('c2', 'SUPPORTED', 0.74),
    ];
    const agg = aggregateVerificationResults(results, 0.75);

    expect(agg.route).toBe('UncertaintyNode');
    expect(agg.verificationScore).toBe(0.75);
    expect(agg.isFullyVerified).toBe(false);
    expect(agg.hasUnresolvedClaims).toBe(true);
  });

  it('Gate A.7: 0.75 + 0.75 (Mean 0.75) routes to ReportNode', () => {
    const results = [
      createResult('c1', 'SUPPORTED', 0.75),
      createResult('c2', 'SUPPORTED', 0.75),
    ];
    const agg = aggregateVerificationResults(results, 0.75);

    expect(agg.route).toBe('ReportNode');
    expect(agg.verificationScore).toBe(0.75);
    expect(agg.isFullyVerified).toBe(true);
  });

  it('Gate A.8: 0.75 + 1.00 (Mean 0.875) routes to ReportNode', () => {
    const results = [
      createResult('c1', 'SUPPORTED', 0.75),
      createResult('c2', 'SUPPORTED', 1.00),
    ];
    const agg = aggregateVerificationResults(results, 0.75);

    expect(agg.route).toBe('ReportNode');
    expect(agg.verificationScore).toBe(0.875);
    expect(agg.isFullyVerified).toBe(true);
  });

  it('Gate A.9: mixed SUPPORTED + PARTIALLY_SUPPORTED routes to UncertaintyNode', () => {
    const results = [
      createResult('c1', 'SUPPORTED', 1.0),
      createResult('c2', 'PARTIALLY_SUPPORTED', 0.7),
    ];
    const agg = aggregateVerificationResults(results, 0.75);

    expect(agg.route).toBe('UncertaintyNode');
    expect(agg.isFullyVerified).toBe(false);
    expect(agg.hasUnresolvedClaims).toBe(true);
    expect(agg.summary.supportedCount).toBe(1);
    expect(agg.summary.partiallySupportedCount).toBe(1);
  });

  it('Gate A.10: all claims SUPPORTED but one low score among many routes to UncertaintyNode', () => {
    const results = [
      createResult('c1', 'SUPPORTED', 0.95),
      createResult('c2', 'SUPPORTED', 0.90),
      createResult('c3', 'SUPPORTED', 0.85),
      createResult('c4', 'SUPPORTED', 0.50), // one low score
    ];
    const agg = aggregateVerificationResults(results, 0.75);

    expect(agg.route).toBe('UncertaintyNode');
    expect(agg.isFullyVerified).toBe(false);
    expect(agg.hasUnresolvedClaims).toBe(true);
  });

  // =========================================================================
  // GATE B: Fail-Closed on Invalid Entailment Scores (No Silent Clamping)
  // =========================================================================
  it('Gate B.11: score = 1.01 triggers VerificationFailedNode (fail closed, score null)', () => {
    const results = [createResult('c1', 'SUPPORTED', 1.01)];
    const agg = aggregateVerificationResults(results, 0.75);

    expect(agg.route).toBe('VerificationFailedNode');
    expect(agg.verificationScore).toBeNull();
    expect(agg.hasOperationalFailure).toBe(true);
    expect(agg.isFullyVerified).toBe(false);
  });

  it('Gate B.12: score = -0.01 triggers VerificationFailedNode (fail closed, score null)', () => {
    const results = [createResult('c1', 'SUPPORTED', -0.01)];
    const agg = aggregateVerificationResults(results, 0.75);

    expect(agg.route).toBe('VerificationFailedNode');
    expect(agg.verificationScore).toBeNull();
    expect(agg.hasOperationalFailure).toBe(true);
    expect(agg.isFullyVerified).toBe(false);
  });

  it('Gate B.13: score = 1.5 triggers VerificationFailedNode (no silent clamping to 1.0)', () => {
    const results = [
      createResult('c1', 'SUPPORTED', 1.0),
      createResult('c2', 'SUPPORTED', 1.5),
    ];
    const agg = aggregateVerificationResults(results, 0.75);

    expect(agg.route).toBe('VerificationFailedNode');
    expect(agg.verificationScore).toBeNull();
    expect(agg.hasOperationalFailure).toBe(true);
    expect(agg.isFullyVerified).toBe(false);
  });

  it('Gate B.14: score = -0.5 triggers VerificationFailedNode (no silent clamping to 0.0)', () => {
    const results = [createResult('c1', 'SUPPORTED', -0.5)];
    const agg = aggregateVerificationResults(results, 0.75);

    expect(agg.route).toBe('VerificationFailedNode');
    expect(agg.verificationScore).toBeNull();
    expect(agg.hasOperationalFailure).toBe(true);
    expect(agg.isFullyVerified).toBe(false);
  });

  it('Gate B.15: score = NaN triggers VerificationFailedNode', () => {
    const results = [createResult('c1', 'SUPPORTED', Number.NaN)];
    const agg = aggregateVerificationResults(results, 0.75);

    expect(agg.route).toBe('VerificationFailedNode');
    expect(agg.verificationScore).toBeNull();
    expect(agg.hasOperationalFailure).toBe(true);
    expect(agg.isFullyVerified).toBe(false);
  });

  it('Gate B.16: score = Infinity triggers VerificationFailedNode', () => {
    const results = [createResult('c1', 'SUPPORTED', Number.POSITIVE_INFINITY)];
    const agg = aggregateVerificationResults(results, 0.75);

    expect(agg.route).toBe('VerificationFailedNode');
    expect(agg.verificationScore).toBeNull();
    expect(agg.hasOperationalFailure).toBe(true);
    expect(agg.isFullyVerified).toBe(false);
  });

  // =========================================================================
  // Epistemic Factual Statuses & Order Invariance
  // =========================================================================
  it('routes any CONTRADICTED claim to UncertaintyNode', () => {
    const results = [
      createResult('c1', 'SUPPORTED', 1.0),
      createResult('c2', 'CONTRADICTED', 0.0),
    ];
    const agg = aggregateVerificationResults(results, 0.75);

    expect(agg.route).toBe('UncertaintyNode');
    expect(agg.isFullyVerified).toBe(false);
    expect(agg.hasUnresolvedClaims).toBe(true);
    expect(agg.summary.contradictedCount).toBe(1);
  });

  it('routes any INSUFFICIENT_EVIDENCE claim to UncertaintyNode', () => {
    const results = [
      createResult('c1', 'SUPPORTED', 1.0),
      createResult('c2', 'INSUFFICIENT_EVIDENCE', 0.0),
    ];
    const agg = aggregateVerificationResults(results, 0.75);

    expect(agg.route).toBe('UncertaintyNode');
    expect(agg.isFullyVerified).toBe(false);
    expect(agg.hasUnresolvedClaims).toBe(true);
    expect(agg.summary.insufficientCount).toBe(1);
  });

  it('routes any CONFLICTING_EVIDENCE claim to UncertaintyNode', () => {
    const results = [
      createResult('c1', 'SUPPORTED', 1.0),
      createResult('c2', 'CONFLICTING_EVIDENCE', 0.3),
    ];
    const agg = aggregateVerificationResults(results, 0.75);

    expect(agg.route).toBe('UncertaintyNode');
    expect(agg.isFullyVerified).toBe(false);
    expect(agg.hasUnresolvedClaims).toBe(true);
    expect(agg.summary.conflictingCount).toBe(1);
  });

  it('routes any VERIFICATION_FAILED claim to VerificationFailedNode with score = null', () => {
    const results = [
      createResult('c1', 'SUPPORTED', 1.0),
      createResult('c2', 'VERIFICATION_FAILED', undefined),
    ];
    const agg = aggregateVerificationResults(results, 0.75);

    expect(agg.route).toBe('VerificationFailedNode');
    expect(agg.verificationScore).toBeNull();
    expect(agg.hasOperationalFailure).toBe(true);
    expect(agg.isFullyVerified).toBe(false);
    expect(agg.summary.failedCount).toBe(1);
  });

  it('preserves deterministic routing regardless of result array ordering', () => {
    const setA = [
      createResult('c1', 'SUPPORTED', 1.0),
      createResult('c2', 'PARTIALLY_SUPPORTED', 0.6),
      createResult('c3', 'INSUFFICIENT_EVIDENCE', 0.0),
    ];
    const setB = [
      createResult('c3', 'INSUFFICIENT_EVIDENCE', 0.0),
      createResult('c1', 'SUPPORTED', 1.0),
      createResult('c2', 'PARTIALLY_SUPPORTED', 0.6),
    ];

    const aggA = aggregateVerificationResults(setA, 0.75);
    const aggB = aggregateVerificationResults(setB, 0.75);

    expect(aggA.route).toBe('UncertaintyNode');
    expect(aggB.route).toBe('UncertaintyNode');
    expect(aggA.verificationScore).toBe(aggB.verificationScore);
    expect(aggA.summary).toEqual(aggB.summary);
  });
});

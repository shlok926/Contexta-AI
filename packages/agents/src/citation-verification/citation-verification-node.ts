import type { AgentState, VerificationResult } from '../state';
import type { IVerificationProvider } from './verification-provider.interface';
import type {
  VerificationRequest,
  VerificationClaimEvaluation,
} from './verification.types';
import { executeStage1DeterministicFilter } from './stage1-filter';
import { VerificationInfrastructureException } from './verification.errors';

export interface RunnableConfigLike {
  readonly configurable?: {
    readonly context?: {
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
      readonly [key: string]: unknown;
    };
    readonly [key: string]: unknown;
  };
  readonly signal?: AbortSignal;
  readonly [key: string]: unknown;
}

export interface CitationVerificationNodeOptions {
  readonly verificationProvider?: IVerificationProvider;
  readonly timeoutMs?: number;
}

/**
 * CitationVerificationNode (N3.8-C5)
 * Orchestrates the authoritative two-stage citation verification cascade:
 *
 *   Claim
 *     ↓
 *   Stage 1 — deterministic safety pre-filter
 *     │
 *     ├── CONTRADICTED ──────────→ finalize claim result (0 provider calls)
 *     │
 *     ├── INSUFFICIENT_EVIDENCE ─→ finalize claim result (0 provider calls)
 *     │
 *     └── STAGE_1_PASSED
 *             ↓
 *       Stage 2 — IVerificationProvider (LLM-as-a-Judge entailment)
 *             ↓
 *       finalize claim result
 *
 * Core Invariants:
 * 1. ZERO provider calls for claims flagged as CONTRADICTED or INSUFFICIENT_EVIDENCE by Stage 1.
 * 2. Provider is invoked ONLY for claims that receive STAGE_1_PASSED.
 * 3. Provider operational failures strictly normalize to status: 'VERIFICATION_FAILED'.
 * 4. Claim-level atomicity: One claim's failure never alters or corrupts another claim's result.
 * 5. Closed-universe citation integrity: Only state.evidenceItems are passed as candidate evidence.
 * 6. Deterministic result ordering: verificationResults[i] strictly corresponds to state.extractedClaims[i].
 * 7. Emits minimal state delta { verificationResults }.
 */
export async function citationVerificationNode(
  state: AgentState,
  config?: RunnableConfigLike,
  options?: CitationVerificationNodeOptions,
): Promise<Partial<AgentState>> {
  // 1. Route Guard: Execute ONLY on 'knowledge_query'
  if (state.routeDecision !== 'knowledge_query') {
    return {};
  }

  // 2. Empty Claims Guard: Return deterministic empty verification results without calling provider
  if (!state.extractedClaims || state.extractedClaims.length === 0) {
    return {
      verificationResults: [],
    };
  }

  // 3. Resolve cancellation signal
  const signal = config?.signal ?? config?.configurable?.context?.signal;
  if (signal?.aborted) {
    throw new VerificationInfrastructureException('CitationVerificationNode aborted before execution');
  }

  // 4. Stage 1 Deterministic Pre-Filter Execution
  const candidateEvidence = state.evidenceItems || [];
  const stage1Result = executeStage1DeterministicFilter(state.extractedClaims, candidateEvidence);
  const stage1Map = new Map(stage1Result.evaluations.map((e) => [e.claimId, e]));

  // 5. Partition claims: Identify which claims require Stage 2 LLM verification
  const passedClaims = state.extractedClaims.filter(
    (claim) => stage1Map.get(claim.claimId)?.status === 'STAGE_1_PASSED',
  );

  const stage2ResultsMap = new Map<string, VerificationResult>();

  // 6. Stage 2 Provider Invocation (Only for STAGE_1_PASSED claims)
  if (passedClaims.length > 0) {
    const provider = options?.verificationProvider;

    if (!provider) {
      for (const claim of passedClaims) {
        stage2ResultsMap.set(claim.claimId, {
          claimId: claim.claimId,
          claimText: claim.claimText,
          status: 'VERIFICATION_FAILED',
          citedChunkIds: [...claim.citedChunkIds],
          stage1Passed: true,
          stage2Evaluated: false,
          failureReason: 'CitationVerificationNode requires a configured IVerificationProvider',
          explanation: 'Verification failed: Missing verification provider.',
        });
      }
    } else {
      const verificationRequest: VerificationRequest = {
        claims: passedClaims.map((c) => ({
          claimId: c.claimId,
          claimText: c.claimText,
          citedChunkIds: c.citedChunkIds,
        })),
        candidateEvidence: candidateEvidence.map((e) => ({
          chunkId: e.chunkId,
          documentTitle: e.documentTitle || 'Untitled Document',
          text: e.text,
          sourceType: e.sourceType,
          chunkOffset: e.chunkOffset,
        })),
        correlationId: state.correlationId,
      };

      try {
        const providerResponse = await provider.verify(verificationRequest, {
          signal,
          timeoutMs: options?.timeoutMs,
        });

        const evalMap = new Map<string, VerificationClaimEvaluation>(
          providerResponse.evaluations.map((e) => [e.claimId, e]),
        );

        for (const claim of passedClaims) {
          const ev = evalMap.get(claim.claimId);
          if (ev) {
            stage2ResultsMap.set(claim.claimId, {
              claimId: claim.claimId,
              claimText: claim.claimText,
              status: ev.status,
              citedChunkIds: [...ev.citedChunkIds],
              entailmentScore: ev.entailmentScore,
              stage1Passed: true,
              stage2Evaluated: true,
              explanation: ev.explanation,
              conflictingChunkIds: ev.conflictingChunkIds ? [...ev.conflictingChunkIds] : undefined,
            });
          } else {
            stage2ResultsMap.set(claim.claimId, {
              claimId: claim.claimId,
              claimText: claim.claimText,
              status: 'VERIFICATION_FAILED',
              citedChunkIds: [...claim.citedChunkIds],
              stage1Passed: true,
              stage2Evaluated: false,
              failureReason: `Provider omitted evaluation for claim ${claim.claimId}`,
              explanation: 'Verification failed: Missing provider evaluation.',
            });
          }
        }
      } catch (err: unknown) {
        // Operational provider failure: normalize all passed claims to VERIFICATION_FAILED
        const rawMessage = err instanceof Error ? err.message : String(err);
        const sanitized = rawMessage
          .replace(/Bearer\s+[A-Za-z0-9-_.]+/gi, '[REDACTED]')
          .replace(/key=[A-Za-z0-9-_.]+/gi, 'key=[REDACTED]');

        for (const claim of passedClaims) {
          stage2ResultsMap.set(claim.claimId, {
            claimId: claim.claimId,
            claimText: claim.claimText,
            status: 'VERIFICATION_FAILED',
            citedChunkIds: [...claim.citedChunkIds],
            stage1Passed: true,
            stage2Evaluated: false,
            failureReason: sanitized,
            explanation: `Verification failed due to operational error: ${sanitized}`,
          });
        }
      }
    }
  }

  // 7. Assemble Final VerificationResults Preserving Deterministic Claim Ordering
  const verificationResults: VerificationResult[] = state.extractedClaims.map((claim) => {
    const stage1Eval = stage1Map.get(claim.claimId);

    if (!stage1Eval) {
      return {
        claimId: claim.claimId,
        claimText: claim.claimText,
        status: 'VERIFICATION_FAILED',
        citedChunkIds: [...claim.citedChunkIds],
        stage1Passed: false,
        stage2Evaluated: false,
        failureReason: `Missing Stage 1 evaluation for claim ${claim.claimId}`,
        explanation: 'Verification failed: Missing Stage 1 evaluation.',
      };
    }

    if (stage1Eval.status === 'CONTRADICTED') {
      return {
        claimId: claim.claimId,
        claimText: claim.claimText,
        status: 'CONTRADICTED',
        citedChunkIds: [...stage1Eval.validCitedChunkIds],
        stage1Passed: false,
        stage2Evaluated: false,
        failureReason: stage1Eval.failureReason,
        explanation: stage1Eval.failureReason ?? 'Deterministic contradiction detected in candidate evidence.',
      };
    }

    if (stage1Eval.status === 'INSUFFICIENT_EVIDENCE') {
      return {
        claimId: claim.claimId,
        claimText: claim.claimText,
        status: 'INSUFFICIENT_EVIDENCE',
        citedChunkIds: [...stage1Eval.validCitedChunkIds],
        stage1Passed: false,
        stage2Evaluated: false,
        failureReason: stage1Eval.failureReason,
        explanation: stage1Eval.failureReason ?? 'Insufficient candidate evidence to evaluate claim.',
      };
    }

    // stage1Eval.status === 'STAGE_1_PASSED'
    const stage2Result = stage2ResultsMap.get(claim.claimId);
    if (stage2Result) {
      return stage2Result;
    }

    return {
      claimId: claim.claimId,
      claimText: claim.claimText,
      status: 'VERIFICATION_FAILED',
      citedChunkIds: [...claim.citedChunkIds],
      stage1Passed: true,
      stage2Evaluated: false,
      failureReason: 'Missing Stage 2 evaluation result',
      explanation: 'Verification failed: Missing Stage 2 evaluation result.',
    };
  });

  // 8. Return minimal state delta
  return {
    verificationResults,
  };
}

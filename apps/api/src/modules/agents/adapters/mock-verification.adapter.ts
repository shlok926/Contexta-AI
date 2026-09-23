import { Injectable, Optional } from '@nestjs/common';
import type {
  IVerificationProvider,
  VerificationProviderOptions,
  VerificationRequest,
  VerificationProviderResponse,
} from '../../../../../../packages/agents/src/index.js';
import {
  VerificationInfrastructureException,
  validateVerificationProviderResponse,
} from '../../../../../../packages/agents/src/index.js';

export interface MockVerificationOptions {
  readonly customResponse?: VerificationProviderResponse | unknown;
  readonly shouldThrow?: boolean;
  readonly throwMessage?: string;
  readonly delayMs?: number;
}

/**
 * MockVerificationAdapter
 * Deterministic test double for IVerificationProvider.
 * Used for testing without invoking external LLM providers.
 */
@Injectable()
export class MockVerificationAdapter implements IVerificationProvider {
  private customResponse?: VerificationProviderResponse | unknown;
  private shouldThrow: boolean;
  private throwMessage: string;
  private delayMs: number;

  constructor(@Optional() options?: MockVerificationOptions) {
    this.customResponse = options?.customResponse;
    this.shouldThrow = options?.shouldThrow ?? false;
    this.throwMessage = options?.throwMessage ?? 'Simulated verification provider failure';
    this.delayMs = options?.delayMs ?? 0;
  }

  setResponse(response: VerificationProviderResponse | unknown): void {
    this.customResponse = response;
  }

  setFailure(shouldThrow: boolean, message = 'Simulated verification provider failure'): void {
    this.shouldThrow = shouldThrow;
    this.throwMessage = message;
  }

  async verify(
    request: VerificationRequest,
    options?: VerificationProviderOptions,
  ): Promise<VerificationProviderResponse> {
    if (options?.signal?.aborted) {
      throw new VerificationInfrastructureException('Citation verification aborted by signal');
    }

    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), this.delayMs);
        if (options?.signal) {
          options.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new VerificationInfrastructureException('Citation verification aborted by signal'));
            },
            { once: true },
          );
        }
      });
    }

    if (this.shouldThrow) {
      throw new VerificationInfrastructureException(this.throwMessage);
    }

    if (this.customResponse !== undefined) {
      try {
        const validated = validateVerificationProviderResponse(this.customResponse);
        this.validateClosedUniverse(request, validated);
        return validated;
      } catch (err) {
        if (err instanceof VerificationInfrastructureException) {
          throw err;
        }
        throw new VerificationInfrastructureException(
          'Verification provider failure: Model output schema validation failed',
          err,
        );
      }
    }

    // Default mock behavior: synthesize deterministic supported evaluations
    const validCandidateChunkIds = request.candidateEvidence.map((e) => e.chunkId);

    const evaluations = request.claims.map((claim) => {
      const validCitations = claim.citedChunkIds.filter((id) => validCandidateChunkIds.includes(id));
      const hasCitations = validCitations.length > 0;

      return {
        claimId: claim.claimId,
        status: hasCitations ? ('SUPPORTED' as const) : ('INSUFFICIENT_EVIDENCE' as const),
        entailmentScore: hasCitations ? 1.0 : 0.0,
        citedChunkIds: validCitations,
        conflictingChunkIds: [],
        explanation: hasCitations
          ? `Evidence chunk ${validCitations.join(', ')} entails claim ${claim.claimId}`
          : `No supporting candidate evidence found for claim ${claim.claimId}`,
      };
    });

    return validateVerificationProviderResponse({ evaluations });
  }

  private validateClosedUniverse(
    request: VerificationRequest,
    response: VerificationProviderResponse,
  ): void {
    const validClaimIds = new Set(request.claims.map((c) => c.claimId));
    const validCandidateChunkIds = new Set(request.candidateEvidence.map((e) => e.chunkId));
    const seenClaimIds = new Set<string>();

    for (const evaluation of response.evaluations) {
      if (!validClaimIds.has(evaluation.claimId)) {
        throw new VerificationInfrastructureException(
          `Verification provider failure: Unknown claimId "${evaluation.claimId}" not present in input claims`,
        );
      }
      if (seenClaimIds.has(evaluation.claimId)) {
        throw new VerificationInfrastructureException(
          `Verification provider failure: Duplicate evaluation for claimId "${evaluation.claimId}"`,
        );
      }
      seenClaimIds.add(evaluation.claimId);

      for (const chunkId of evaluation.citedChunkIds) {
        if (!validCandidateChunkIds.has(chunkId)) {
          throw new VerificationInfrastructureException(
            `Verification provider failure: Unknown citedChunkId "${chunkId}" violates closed evidence universe`,
          );
        }
      }
      if (evaluation.conflictingChunkIds) {
        for (const chunkId of evaluation.conflictingChunkIds) {
          if (!validCandidateChunkIds.has(chunkId)) {
            throw new VerificationInfrastructureException(
              `Verification provider failure: Unknown conflictingChunkId "${chunkId}" violates closed evidence universe`,
            );
          }
        }
      }
    }
  }
}

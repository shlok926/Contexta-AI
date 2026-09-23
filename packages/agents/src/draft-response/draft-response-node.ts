import type { AgentState, ExtractedClaim } from '../state';
import { buildDraftResponsePrompt } from './draft-prompt';
import type { IDraftGeneratorProvider } from './draft-generator.interface';
import { DraftGeneratorInfrastructureException } from './draft-generator.interface';
import { validateDraftResponse } from './draft-response.schema';

/**
 * Typed exception thrown when model output violates application-level invariants
 * (e.g. unknown evidence reference not present in supplied state.evidenceItems).
 */
export class DraftResponseValidationException extends Error {
  public readonly code: string = 'DRAFT_RESPONSE_VALIDATION_FAILURE';

  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'DraftResponseValidationException';
    Object.setPrototypeOf(this, DraftResponseValidationException.prototype);
  }
}

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

export interface DraftResponseNodeOptions {
  readonly draftGeneratorProvider?: IDraftGeneratorProvider;
  readonly timeoutMs?: number;
}

export const INSUFFICIENT_EVIDENCE_DRAFT_RESPONSE =
  'I could not find sufficient information in the available documentation to answer your question.';

/**
 * DraftResponseNode (N3.7)
 * Synthesizes an evidence-grounded draft response from N3.6 EvidenceItem[],
 * performs authoritative candidate-evidence allowlisting, normalizes deterministic claim IDs,
 * and emits minimal state delta { draftResponse, extractedClaims }.
 */
export async function draftResponseNode(
  state: AgentState,
  config?: RunnableConfigLike,
  options?: DraftResponseNodeOptions,
): Promise<Partial<AgentState>> {
  // 1. Route Guard: Execute ONLY on 'knowledge_query'
  if (state.routeDecision !== 'knowledge_query') {
    return {};
  }

  // 2. Empty Evidence Guard: Return deterministic safe insufficient-evidence draft without calling LLM
  if (!state.evidenceItems || state.evidenceItems.length === 0) {
    return {
      draftResponse: INSUFFICIENT_EVIDENCE_DRAFT_RESPONSE,
      extractedClaims: [],
    };
  }

  // 3. Resolve cancellation signal and query text
  const signal = config?.signal ?? config?.configurable?.context?.signal;
  if (signal?.aborted) {
    throw new DraftGeneratorInfrastructureException('DraftResponseNode aborted before execution');
  }

  const query = state.normalizedQuery || state.originalQuery || '';
  const prompt = buildDraftResponsePrompt({
    query,
    evidenceItems: state.evidenceItems,
  });

  const provider = options?.draftGeneratorProvider;
  if (!provider) {
    throw new DraftGeneratorInfrastructureException(
      'DraftResponseNode requires a configured IDraftGeneratorProvider',
    );
  }

  // 4. Invoke LLM Provider
  const rawDraft = await provider.generateDraft(prompt, {
    signal,
    timeoutMs: options?.timeoutMs,
  });

  // 5. Validate schema (Defense-in-depth)
  const validatedDraft = validateDraftResponse(rawDraft);

  // 6. Authoritative Evidence Allowlisting & Identifier Mapping
  // Build lookup maps from actual state.evidenceItems
  const allowlistMap = new Map<string, string>(); // ref -> canonical chunkId
  for (const item of state.evidenceItems) {
    if (item.chunkId) {
      allowlistMap.set(item.chunkId, item.chunkId);
    }
    if (item.evidenceId) {
      allowlistMap.set(item.evidenceId, item.chunkId);
    }
  }

  const normalizedClaims: ExtractedClaim[] = [];

  for (let i = 0; i < validatedDraft.extractedClaims.length; i++) {
    const rawClaim = validatedDraft.extractedClaims[i];
    const canonicalChunkIds: string[] = [];

    for (const ref of rawClaim.citedChunkIds) {
      const canonicalChunkId = allowlistMap.get(ref);
      if (!canonicalChunkId) {
        throw new DraftResponseValidationException(
          `Evidence allowlist violation: cited identifier '${ref}' does not exist in the supplied evidence items`,
        );
      }
      if (!canonicalChunkIds.includes(canonicalChunkId)) {
        canonicalChunkIds.push(canonicalChunkId);
      }
    }

    // Deterministic Application-Owned Claim Identity: claim_${state.runId}_${index}
    const deterministicClaimId = `claim_${state.runId}_${i}`;

    normalizedClaims.push({
      claimId: deterministicClaimId,
      claimText: rawClaim.claimText.trim(),
      citedChunkIds: canonicalChunkIds,
    });
  }

  // 7. Return minimal state delta
  return {
    draftResponse: validatedDraft.answer.trim(),
    extractedClaims: normalizedClaims,
  };
}

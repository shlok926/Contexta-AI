import type {
  VerificationRequest,
  VerificationProviderResponse,
} from './verification.types';

/**
 * VerificationProviderOptions
 * Execution options passed to IVerificationProvider (e.g. timeout, abort signal).
 */
export interface VerificationProviderOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * IVerificationProvider
 * Framework and provider-agnostic interface for invoking Stage 2 LLM-as-a-Judge entailment verification.
 * Adheres to ADR-0001 (Modular Monolith) and ADR-0003 (Citation Entailment).
 *
 * Requirements:
 * 1. Zero dependencies on NestJS, HTTP request objects, Supabase, or AgentState.
 * 2. Pure semantic verification over (claims, candidateEvidence).
 * 3. Enforces typed infrastructure exceptions on failure.
 */
export interface IVerificationProvider {
  verify(
    request: VerificationRequest,
    options?: VerificationProviderOptions,
  ): Promise<VerificationProviderResponse>;
}

/**
 * Canonical Server-Sent Events (SSE) Event Envelope & Payload DTOs (N3.8-C7.4).
 *
 * Adheres strictly to ADR-0006 §11 and the C7.4 Discovery & Implementation Contract.
 * Strict projection boundaries prevent leakage of:
 * - Credentials, API keys, or Bearer tokens
 * - Raw AgentState or internal node state
 * - Prompts, chain-of-thought, or internal reasoning
 * - Embeddings, vector chunks, or SQL traces
 * - Unverified factual draft claims (quarantined until verification)
 */

export type SseProgressPhase = 'routing' | 'retrieving' | 'synthesizing' | 'verifying';

export type SseTerminalStatus = 'completed' | 'declined_uncertain';

/**
 * Event: 'run_started'
 * Emitted immediately following atomic run turn creation and transition to running.
 */
export interface SseRunStartedPayload {
  readonly run_id: string;
  readonly thread_id: string;
  readonly workspace_id: string;
}

/**
 * Event: 'run_progress'
 * Emitted as graph nodes complete execution steps.
 * Strict allowlist of predefined progress phases and safe human-readable messages.
 */
export interface SseRunProgressPayload {
  readonly phase: SseProgressPhase;
  readonly message: string;
}

/**
 * Event: 'citation_created'
 * Emitted when a factual claim is evaluated by CitationNode.
 * Strict allowlist of public claim identifiers and verification confidence.
 */
export interface SseCitationCreatedPayload {
  readonly claim_id: string;
  readonly claim_text: string;
  readonly status: string;
  readonly confidence_score?: number;
}

/**
 * Event: 'token'
 * Emitted STRICTLY post-verification from ReportNode or DirectAnswer.
 * DraftResponseNode text is NEVER streamed as tokens prior to verification gate.
 */
export interface SseTokenPayload {
  readonly delta: string;
}

/**
 * Event: 'response_ready'
 * Emitted when verified final content is assembled before database commit.
 */
export interface SseResponseReadyPayload {
  readonly content: string;
  readonly status: SseTerminalStatus;
  readonly verification_score?: number | null;
}

/**
 * Event: 'error'
 * Terminal failure event emitted on operational/infrastructure failures or cancellation.
 */
export interface SseErrorPayload {
  readonly code: string;
  readonly message: string;
}

/**
 * Event: 'done'
 * Terminal success event emitted strictly after atomic DB commitment (commit_agent_run_response).
 */
export interface SseDonePayload {
  readonly run_id: string;
  readonly duration_ms: number;
  readonly completed_at: string;
}

export type SsePayload =
  | SseRunStartedPayload
  | SseRunProgressPayload
  | SseCitationCreatedPayload
  | SseTokenPayload
  | SseResponseReadyPayload
  | SseErrorPayload
  | SseDonePayload;

/**
 * Authoritative Canonical SSE Envelope.
 * Guaranteed monotonic sequence numbering, stable request/run/thread IDs, and ISO-8601 timestamps.
 */
export interface CanonicalSseEnvelope<T = SsePayload> {
  readonly event: string;
  readonly request_id: string;
  readonly run_id: string;
  readonly thread_id: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly payload: T;
}

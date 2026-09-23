import type { ProtectedContextField } from '../../../../../../packages/agents/src/state.js';

/**
 * Input parameters supplied alongside an authenticated RequestContext
 * to construct the runtime execution context and initialize AgentState.
 *
 * Security Invariants:
 * 1. TENANT & IDENTITY INTEGRITY: Callers CANNOT supply userId, workspaceId,
 *    organizationId, roles, or permissions here. All security-sensitive boundaries
 *    MUST originate exclusively from the authoritative N2 RequestContext.
 * 2. CANONICAL RUN IDENTITY: `runId` is mandatory and corresponds 1:1 with `agent_runs.id`.
 *    No synthetic production fallback is generated.
 * 3. THREAD TENANCY CONSISTENCY: `threadId` is validated against authorized workspace
 *    scope and discrete `thread:read` / `thread:create` capabilities.
 */
export interface IngestRequestContextInput {
  /** Target thread UUID for the conversation */
  readonly threadId: string;

  /** Unmodified user question text */
  readonly originalQuery: string;

  /**
   * Canonical run identifier (UUIDv4) mapping 1:1 with agent_runs(id).
   * Required in production. No random fallback is generated.
   */
  readonly runId?: string;

  /**
   * Optional workspace identifier associated with the thread resource.
   * If provided, must match requestContext.tenantScope.workspaceId exactly.
   */
  readonly threadWorkspaceId?: string;
}

/**
 * Protected runtime context extracted from the authoritative N2 RequestContext
 * and validated input. Immutable and non-nullable.
 */
export interface IngestedProtectedContext {
  readonly runId: string;
  readonly correlationId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly originalQuery: string;
}

export type { ProtectedContextField };

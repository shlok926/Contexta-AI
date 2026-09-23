import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Distributed trace metadata attached to an ExecutionContext.
 * Strictly allowlisted primitive values only.
 */
export interface TraceMetadata {
  readonly correlationId: string;
  readonly runId?: string;
  readonly [key: string]: string | number | boolean | undefined;
}

/**
 * ExecutionContext is an ephemeral, non-serializable runtime execution handle.
 *
 * Architectural Invariants:
 * 1. RUNTIME INFRASTRUCTURE HANDLE ONLY: `supabaseClient` is an infrastructure-level
 *    handle passed strictly via `RunnableConfig.configurable` for runtime-layer coordination.
 *    AgentState and future domain agent nodes MUST NOT consume `supabaseClient` directly
 *    or treat `ExecutionContext` as a database service locator.
 *    - Domain memory operations MUST use `MemoryProvider` (ADR-0004).
 *    - Domain retrieval operations MUST use `RetrievalPort` (ADR-0009).
 * 2. NEVER SERIALIZED: Must NEVER be placed into `AgentState` or serialized to JSON.
 * 3. NO RAW TOKENS: Does not store raw Bearer tokens, Authorization headers, or service keys.
 * 4. REQUEST ISOLATED: Bound strictly to the caller's request-scoped Supabase client under active RLS.
 */
export interface ExecutionContext {
  /**
   * Request-scoped Supabase client bound to caller's verified session.
   * Architectural Boundary: Infrastructure handle only; domain nodes must NOT call directly.
   */
  readonly supabaseClient: SupabaseClient;

  /** Abort signal for timeout and client-initiated cancellation */
  readonly signal?: AbortSignal;

  /**
   * Total execution budget in milliseconds supplied to the runtime.
   * Note: N3.1 establishes this contract field; enforcement is deferred to runtime orchestration stages.
   */
  readonly timeoutMs?: number;

  /** Distributed tracing and correlation handles */
  readonly traceMetadata?: Readonly<TraceMetadata>;
}


/**
 * Parameters for constructing an immutable ExecutionContext.
 */
export interface CreateExecutionContextParams {
  readonly supabaseClient: SupabaseClient;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly traceMetadata?: TraceMetadata;
}

/**
 * Creates and physically freezes an ExecutionContext instance.
 *
 * Guarantees:
 * - Top-level properties are read-only and frozen.
 * - Non-serializable handles remain quarantined from graph state.
 */
export function createExecutionContext(params: CreateExecutionContextParams): ExecutionContext {
  if (!params.supabaseClient || typeof params.supabaseClient !== 'object') {
    throw new TypeError('ExecutionContext requires a valid SupabaseClient instance');
  }

  const frozenTraceMetadata = params.traceMetadata
    ? Object.freeze({ ...params.traceMetadata })
    : undefined;

  return Object.freeze({
    supabaseClient: params.supabaseClient,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
    traceMetadata: frozenTraceMetadata,
  });
}

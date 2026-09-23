import type { ExecutionContext } from '../interfaces/execution-context.interface.js';

/**
 * Key used to store the ExecutionContext inside LangChain's `configurable` dictionary.
 */
export const EXECUTION_CONTEXT_KEY = 'executionContext' as const;

/**
 * Strongly typed configurable dictionary injected into LangChain `RunnableConfig.configurable`.
 */
export interface AgentRunnableConfigurable {
  readonly [EXECUTION_CONTEXT_KEY]: ExecutionContext;
  readonly [key: string]: unknown;
}

/**
 * Optional parameters for constructing an AgentRunnableConfig.
 */
export interface CreateAgentRunnableConfigOptions {
  readonly runName?: string;
  readonly tags?: readonly string[];
  readonly maxConcurrency?: number;
  readonly recursionLimit?: number;
}

/**
 * Strongly typed LangChain RunnableConfig interface carrying the non-serialized ExecutionContext.
 */
export interface AgentRunnableConfig {
  readonly configurable: AgentRunnableConfigurable;
  readonly signal?: AbortSignal;
  readonly timeout?: number;
  readonly runName?: string;
  readonly tags?: readonly string[];
  readonly maxConcurrency?: number;
  readonly recursionLimit?: number;
}

/**
 * Generic configuration shape accepted when extracting ExecutionContext.
 */
export type RunnableConfigLike =
  | AgentRunnableConfig
  | { readonly configurable?: Record<string, unknown> | AgentRunnableConfigurable }
  | null
  | undefined;

/**
 * Bridges an ExecutionContext into a typed LangChain RunnableConfig.
 *
 * Invariants:
 * 1. The ExecutionContext is placed strictly under `configurable.executionContext`.
 * 2. AbortSignal and timeoutMs from ExecutionContext propagate to RunnableConfig defaults.
 * 3. The returned config object is frozen against runtime mutation.
 */
export function createAgentRunnableConfig(
  context: ExecutionContext,
  options?: CreateAgentRunnableConfigOptions,
): AgentRunnableConfig {
  if (!context || typeof context !== 'object' || !context.supabaseClient) {
    throw new TypeError('Cannot create RunnableConfig without a valid ExecutionContext');
  }

  const configurable: AgentRunnableConfigurable = Object.freeze({
    [EXECUTION_CONTEXT_KEY]: context,
  });

  const config: AgentRunnableConfig = Object.freeze({
    configurable,
    signal: context.signal,
    timeout: context.timeoutMs,
    runName: options?.runName,
    tags: options?.tags ? Object.freeze([...options.tags]) : undefined,
    maxConcurrency: options?.maxConcurrency,
    recursionLimit: options?.recursionLimit,
  });

  return config;
}

/**
 * Extracts and validates the ExecutionContext from a LangChain RunnableConfig.
 *
 * Returns undefined if config or configurable does not contain a valid ExecutionContext.
 */
export function extractExecutionContext(
  config?: RunnableConfigLike,
): ExecutionContext | undefined {
  if (!config || typeof config !== 'object') {
    return undefined;
  }

  const configurable = config.configurable;
  if (!configurable || typeof configurable !== 'object') {
    return undefined;
  }

  const ctx = (configurable as Record<string, unknown>)[EXECUTION_CONTEXT_KEY];
  if (!ctx || typeof ctx !== 'object') {
    return undefined;
  }

  const candidate = ctx as ExecutionContext;
  if (!candidate.supabaseClient || typeof candidate.supabaseClient !== 'object') {
    return undefined;
  }

  return candidate;
}


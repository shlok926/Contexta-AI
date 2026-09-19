import type { RequestContext } from '../../identity/interfaces/request-context.interface.js';

/**
 * Module-private symbol used exclusively by the infrastructure layer (JwtAuthGuard)
 * to temporarily bind the cryptographically verified JWT string to the private request state
 * for downstream consumption by the request-scoped SupabaseService.
 *
 * Security Invariant: This symbol is non-enumerable, not exposed to domain services,
 * and never stored on RequestContext or serialized in API responses.
 */
export const REQUEST_TOKEN_SYMBOL: unique symbol = Symbol('REQUEST_TOKEN_SYMBOL');

/**
 * Module-private symbol used to attach the immutable RequestContext to the request object.
 */
export const REQUEST_CONTEXT_SYMBOL: unique symbol = Symbol('REQUEST_CONTEXT_SYMBOL');

/**
 * Internal carrier interface for request objects holding private context state.
 */
export interface RequestWithPrivateState {
  [REQUEST_TOKEN_SYMBOL]?: string;
  [REQUEST_CONTEXT_SYMBOL]?: RequestContext;
  [key: string | symbol]: unknown;
}

/**
 * Binds a cryptographically verified bearer token to the private request symbol.
 * Enforces fail-closed lifecycle protection: attempting to overwrite an already-bound
 * token with a different value throws an error.
 */
export function bindVerifiedToken(req: unknown, token: string): void {
  if (!req || (typeof req !== 'object' && typeof req !== 'function')) {
    throw new Error('Invalid request object provided for token binding');
  }

  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    throw new Error('Cannot bind an empty or non-string token');
  }

  const target = req as RequestWithPrivateState;
  const existingToken = target[REQUEST_TOKEN_SYMBOL];

  if (existingToken !== undefined && existingToken !== token) {
    throw new Error('Cannot overwrite existing verified token on request');
  }

  target[REQUEST_TOKEN_SYMBOL] = token;
}

/**
 * Retrieves the cryptographically verified token from the private request symbol.
 * Returns undefined if uninitialized or not yet verified.
 */
export function getVerifiedToken(req: unknown): string | undefined {
  if (!req || (typeof req !== 'object' && typeof req !== 'function')) {
    return undefined;
  }
  return (req as RequestWithPrivateState)[REQUEST_TOKEN_SYMBOL];
}

/**
 * Binds an immutable RequestContext to the private request symbol.
 * Enforces fail-closed lifecycle protection: attempting to replace an existing
 * RequestContext with a different instance throws an error.
 */
export function bindRequestContext(req: unknown, context: RequestContext): void {
  if (!req || (typeof req !== 'object' && typeof req !== 'function')) {
    throw new Error('Invalid request object provided for context binding');
  }

  if (!context || typeof context !== 'object') {
    throw new Error('Cannot bind an invalid or empty RequestContext');
  }

  const target = req as RequestWithPrivateState;
  const existingContext = target[REQUEST_CONTEXT_SYMBOL];

  if (existingContext !== undefined && existingContext !== context) {
    const isEnrichment =
      existingContext.tenantScope === undefined &&
      context.tenantScope !== undefined &&
      existingContext.principal.userId === context.principal.userId &&
      existingContext.principal.organizationId === context.principal.organizationId &&
      existingContext.metadata.correlationId === context.metadata.correlationId;

    if (!isEnrichment) {
      throw new Error('Cannot overwrite existing RequestContext on request');
    }
  }

  target[REQUEST_CONTEXT_SYMBOL] = context;
}

/**
 * Retrieves the immutable RequestContext from the private request symbol.
 * Returns undefined if uninitialized.
 */
export function getRequestContext(req: unknown): RequestContext | undefined {
  if (!req || (typeof req !== 'object' && typeof req !== 'function')) {
    return undefined;
  }
  return (req as RequestWithPrivateState)[REQUEST_CONTEXT_SYMBOL];
}

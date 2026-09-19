import type { Request } from 'express';

/**
 * Infrastructure execution handle passed into domain/application services
 * strictly to derive the NestJS ContextId via ContextIdFactory.getByRequest(context.rawRequest).
 *
 * Security Invariant: Application and domain services MUST NOT inspect rawRequest
 * for HTTP headers, Authorization, body fields, query parameters, or caller-controlled state.
 */
export interface RequestExecutionContext {
  readonly rawRequest: Request;
}

/**
 * Factory helper to construct a RequestExecutionContext handle.
 */
export function createRequestExecutionContext(rawRequest: Request): RequestExecutionContext {
  return Object.freeze({
    rawRequest,
  });
}

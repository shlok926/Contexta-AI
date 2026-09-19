import { Injectable, NestMiddleware } from '@nestjs/common';
import * as crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const CORRELATION_ID_SYMBOL: unique symbol = Symbol('CORRELATION_ID_SYMBOL');

/**
 * Valid correlation ID format:
 * - Printable ASCII characters (alphanumeric, hyphens, underscores, dots)
 * - Length between 1 and 64 characters
 * - No whitespace, control characters, or header injection characters
 */
const VALID_CORRELATION_ID_REGEX = /^[a-zA-Z0-9._-]{1,64}$/;

/**
 * Validates whether an incoming correlation identifier conforms to safety invariants.
 */
export function isValidCorrelationId(id: unknown): id is string {
  if (typeof id !== 'string') {
    return false;
  }
  const trimmed = id.trim();
  return trimmed.length > 0 && trimmed.length <= 64 && VALID_CORRELATION_ID_REGEX.test(trimmed);
}

/**
 * Extracts or retrieves the canonical correlation ID from a request object.
 */
export function getCorrelationId(req: unknown): string {
  if (!req || typeof req !== 'object') {
    return crypto.randomUUID();
  }

  const target = req as Record<string | symbol, unknown>;
  if (typeof target[CORRELATION_ID_SYMBOL] === 'string' && target[CORRELATION_ID_SYMBOL]) {
    return target[CORRELATION_ID_SYMBOL] as string;
  }

  const headers = target.headers as Record<string, string | string[] | undefined> | undefined;
  if (headers) {
    const raw = headers[CORRELATION_ID_HEADER];
    const candidate = Array.isArray(raw) ? raw[0] : raw;
    if (isValidCorrelationId(candidate)) {
      return candidate.trim();
    }
  }

  return crypto.randomUUID();
}

/**
 * Attaches the canonical correlation ID to private request state.
 */
export function bindCorrelationId(req: unknown, correlationId: string): void {
  if (!req || typeof req !== 'object') {
    return;
  }

  const target = req as Record<string | symbol, unknown>;
  target[CORRELATION_ID_SYMBOL] = correlationId;

  const headers = target.headers as Record<string, string | string[] | undefined> | undefined;
  if (headers) {
    headers[CORRELATION_ID_HEADER] = correlationId;
  }
}

/**
 * Correlation ID Middleware:
 * 1. Inspects incoming X-Correlation-ID header.
 * 2. Validates safety and format (replaces invalid/missing/malformed with crypto.randomUUID()).
 * 3. Binds canonical correlationId to private request state and normalized request headers.
 * 4. Injects X-Correlation-ID header into the outgoing HTTP response.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const headers = req.headers;
    const incomingHeader = headers ? headers[CORRELATION_ID_HEADER] : undefined;
    const rawId = Array.isArray(incomingHeader) ? incomingHeader[0] : incomingHeader;

    let correlationId: string;
    if (isValidCorrelationId(rawId)) {
      correlationId = rawId.trim();
    } else {
      correlationId = crypto.randomUUID();
    }

    // Bind canonical correlation ID to request
    bindCorrelationId(req, correlationId);

    // Set header on outgoing response
    if (res && typeof res.setHeader === 'function') {
      res.setHeader('X-Correlation-ID', correlationId);
    }

    next();
  }
}

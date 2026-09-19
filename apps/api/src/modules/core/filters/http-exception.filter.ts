import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { getCorrelationId } from '../middleware/correlation-id.middleware.js';
import { getRequestContext } from '../supabase/symbols.js';
import type { ProblemDetails } from '../interfaces/problem-details.interface.js';

/**
 * Canonical HTTP Status Code to Standard Problem Details Title Mapping
 */
const HTTP_STATUS_TITLES: Readonly<Record<number, string>> = Object.freeze({
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'Method Not Allowed',
  [HttpStatus.NOT_ACCEPTABLE]: 'Not Acceptable',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.GONE]: 'Gone',
  [HttpStatus.PRECONDITION_FAILED]: 'Precondition Failed',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'Payload Too Large',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'Unsupported Media Type',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable Entity',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too Many Requests',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal Server Error',
  [HttpStatus.NOT_IMPLEMENTED]: 'Not Implemented',
  [HttpStatus.BAD_GATEWAY]: 'Bad Gateway',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Service Unavailable',
  [HttpStatus.GATEWAY_TIMEOUT]: 'Gateway Timeout',
});

function getStandardTitle(status: number): string {
  return HTTP_STATUS_TITLES[status] || 'HTTP Exception';
}

/**
 * Sanitizes request URL to produce a safe instance path without query strings or sensitive parameters.
 */
function extractSafeInstance(request?: Request): string {
  if (!request) {
    return '/';
  }
  if (typeof request.path === 'string' && request.path.length > 0) {
    return request.path;
  }
  if (typeof request.url === 'string' && request.url.length > 0) {
    return request.url.split('?')[0] || '/';
  }
  return '/';
}

/**
 * Resolves the canonical correlation ID for the error response.
 */
function resolveCorrelationId(request?: Request): string {
  if (!request) {
    return getCorrelationId(undefined);
  }

  // 1. Check RequestContext metadata if established
  const context = getRequestContext(request);
  if (context?.metadata?.correlationId) {
    return context.metadata.correlationId;
  }

  // 2. Check request-bound correlation ID or header
  return getCorrelationId(request);
}

/**
 * RFC 7807 Global Exception Filter:
 * Transforms all application exceptions into standard Problem Details responses (application/problem+json).
 *
 * Security Invariants:
 * - Sanitizes all 500 / unexpected errors (zero stack traces, SQL, file paths, or secrets leaked).
 * - Preserves established HTTP semantics (401 unauthenticated, 403 unauthorized, 404 anti-enumeration).
 * - Maintains correlation ID consistency between response body and X-Correlation-ID header.
 * - Explicitly constructs safe Problem Details payload; never blindly serializes raw exception objects.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    if (!response || typeof response.status !== 'function') {
      return;
    }

    if (response.headersSent) {
      return;
    }

    const correlationId = resolveCorrelationId(request);
    const instance = extractSafeInstance(request);

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let title = 'Internal Server Error';
    let detail = 'An unexpected error occurred.';
    let errors: Array<{ field?: string; message: string }> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      title = getStandardTitle(status);

      const res = exception.getResponse();
      if (typeof res === 'string') {
        detail = res;
      } else if (res && typeof res === 'object') {
        const resObj = res as Record<string, unknown>;
        if (typeof resObj.message === 'string') {
          detail = resObj.message;
        } else if (Array.isArray(resObj.message)) {
          // Handles class-validator error array
          const messages = resObj.message.filter((m): m is string => typeof m === 'string');
          detail = messages.join('; ');
          errors = messages.map((msg) => ({ message: msg }));
        } else if (typeof resObj.error === 'string') {
          detail = resObj.error;
        } else {
          detail = exception.message || title;
        }

        if (typeof resObj.title === 'string' && resObj.title.trim().length > 0) {
          title = resObj.title.trim();
        }
      } else {
        detail = exception.message || title;
      }
    }

    const problemDetails: ProblemDetails = {
      type: 'about:blank',
      title,
      status,
      detail,
      instance,
      correlation_id: correlationId,
      ...(errors && errors.length > 0 ? { errors } : {}),
    };

    response.setHeader('Content-Type', 'application/problem+json');
    response.setHeader('X-Correlation-ID', correlationId);
    response.status(status).json(problemDetails);
  }
}

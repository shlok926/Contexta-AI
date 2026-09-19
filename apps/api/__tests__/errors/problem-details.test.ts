import {
  HttpException,
  HttpStatus,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
  ArgumentsHost,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { HttpExceptionFilter } from '../../src/modules/core/filters/http-exception.filter.js';
import {
  CorrelationIdMiddleware,
  CORRELATION_ID_HEADER,
  getCorrelationId,
  isValidCorrelationId,
} from '../../src/modules/core/middleware/correlation-id.middleware.js';
import {
  createRequestContext,
} from '../../src/modules/identity/interfaces/request-context.interface.js';
import { bindRequestContext } from '../../src/modules/core/supabase/symbols.js';
import type { ProblemDetails } from '../../src/modules/core/interfaces/problem-details.interface.js';

describe('N2.8 RFC 7807 Problem Details & Correlation ID Infrastructure', () => {
  // Helper to create mock Express Response
  function createMockResponse(): {
    res: Response;
    headers: Record<string, string>;
    statusCode: number;
    jsonBody: unknown;
  } {
    const headers: Record<string, string> = {};
    let statusCode = 200;
    let jsonBody: unknown;

    const res = {
      setHeader: (name: string, value: string) => {
        headers[name.toLowerCase()] = value;
      },
      getHeader: (name: string) => headers[name.toLowerCase()],
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (body: unknown) => {
        jsonBody = body;
        return res;
      },
      headersSent: false,
    } as unknown as Response;

    return {
      res,
      get headers() {
        return headers;
      },
      get statusCode() {
        return statusCode;
      },
      get jsonBody() {
        return jsonBody;
      },
    };
  }

  // Helper to create mock Express Request
  function createMockRequest(options: {
    path?: string;
    url?: string;
    headers?: Record<string, string | string[]>;
    correlationId?: string;
  } = {}): Request {
    const headers: Record<string, string | string[] | undefined> = {
      ...(options.headers || {}),
    };
    if (options.correlationId) {
      headers[CORRELATION_ID_HEADER] = options.correlationId;
    }

    return {
      path: options.path ?? '/v1/test',
      url: options.url ?? options.path ?? '/v1/test',
      headers,
    } as unknown as Request;
  }

  function createMockHost(req: Request, res: Response): ArgumentsHost {
    return {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
        getNext: () => ({}),
      }),
      getArgs: () => [req, res],
      getArgByIndex: () => ({}),
      switchToRpc: () => ({}) as never,
      switchToWs: () => ({}) as never,
      getType: () => 'http',
    } as unknown as ArgumentsHost;
  }

  // =========================================================================
  // 1. CORRELATION ID MIDDLEWARE TESTS
  // =========================================================================
  describe('CorrelationIdMiddleware', () => {
    let middleware: CorrelationIdMiddleware;

    beforeEach(() => {
      middleware = new CorrelationIdMiddleware();
    });

    it('should generate a cryptographically strong UUID when X-Correlation-ID header is missing', () => {
      const req = createMockRequest();
      const mockRes = createMockResponse();
      let nextCalled = false;

      middleware.use(req, mockRes.res, () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);
      const generatedId = getCorrelationId(req);
      expect(generatedId).toBeDefined();
      expect(isValidCorrelationId(generatedId)).toBe(true);
      // Valid UUID v4 regex
      expect(generatedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(mockRes.headers['x-correlation-id']).toBe(generatedId);
      expect(req.headers[CORRELATION_ID_HEADER]).toBe(generatedId);
    });

    it('should preserve a valid incoming X-Correlation-ID header', () => {
      const validId = 'client-corr-id-12345';
      const req = createMockRequest({ correlationId: validId });
      const mockRes = createMockResponse();

      middleware.use(req, mockRes.res, () => {});

      expect(getCorrelationId(req)).toBe(validId);
      expect(mockRes.headers['x-correlation-id']).toBe(validId);
    });

    it('should replace an empty or whitespace-only X-Correlation-ID with a fresh UUID', () => {
      const req = createMockRequest({ correlationId: '   ' });
      const mockRes = createMockResponse();

      middleware.use(req, mockRes.res, () => {});

      const id = getCorrelationId(req);
      expect(id).not.toBe('   ');
      expect(isValidCorrelationId(id)).toBe(true);
      expect(mockRes.headers['x-correlation-id']).toBe(id);
    });

    it('should replace excessively long (>64 chars) X-Correlation-ID with a fresh UUID', () => {
      const tooLongId = 'a'.repeat(65);
      const req = createMockRequest({ correlationId: tooLongId });
      const mockRes = createMockResponse();

      middleware.use(req, mockRes.res, () => {});

      const id = getCorrelationId(req);
      expect(id).not.toBe(tooLongId);
      expect(id.length).toBeLessThanOrEqual(64);
      expect(isValidCorrelationId(id)).toBe(true);
    });

    it('should replace X-Correlation-ID containing control characters or header injection with a fresh UUID', () => {
      const injectionAttempt = 'valid-id\r\nInjected-Header: evil\n';
      const req = createMockRequest({ correlationId: injectionAttempt });
      const mockRes = createMockResponse();

      middleware.use(req, mockRes.res, () => {});

      const id = getCorrelationId(req);
      expect(id).not.toContain('\r');
      expect(id).not.toContain('\n');
      expect(isValidCorrelationId(id)).toBe(true);
    });

    it('should ensure concurrent requests receive completely isolated distinct correlation IDs', () => {
      const reqA = createMockRequest();
      const resA = createMockResponse();
      const reqB = createMockRequest();
      const resB = createMockResponse();

      middleware.use(reqA, resA.res, () => {});
      middleware.use(reqB, resB.res, () => {});

      const idA = getCorrelationId(reqA);
      const idB = getCorrelationId(reqB);

      expect(idA).toBeDefined();
      expect(idB).toBeDefined();
      expect(idA).not.toBe(idB);
      expect(resA.headers['x-correlation-id']).toBe(idA);
      expect(resB.headers['x-correlation-id']).toBe(idB);
    });
  });

  // =========================================================================
  // 2. HTTP EXCEPTION FILTER & RFC 7807 PROBLEM DETAILS TESTS
  // =========================================================================
  describe('HttpExceptionFilter (RFC 7807)', () => {
    let filter: HttpExceptionFilter;

    beforeEach(() => {
      filter = new HttpExceptionFilter();
    });

    it('should format 400 BadRequestException as RFC 7807 Problem Details', () => {
      const req = createMockRequest({ path: '/v1/workspaces', correlationId: 'corr-400' });
      const mockRes = createMockResponse();
      const host = createMockHost(req, mockRes.res);

      const exception = new BadRequestException('Workspace name is required');
      filter.catch(exception, host);

      expect(mockRes.statusCode).toBe(400);
      expect(mockRes.headers['content-type']).toBe('application/problem+json');
      expect(mockRes.headers['x-correlation-id']).toBe('corr-400');

      const body = mockRes.jsonBody as ProblemDetails;
      expect(body.type).toBe('about:blank');
      expect(body.title).toBe('Bad Request');
      expect(body.status).toBe(400);
      expect(body.detail).toBe('Workspace name is required');
      expect(body.instance).toBe('/v1/workspaces');
      expect(body.correlation_id).toBe('corr-400');
    });

    it('should format 401 UnauthorizedException as RFC 7807 Problem Details', () => {
      const req = createMockRequest({ path: '/v1/auth/session', correlationId: 'corr-401' });
      const mockRes = createMockResponse();
      const host = createMockHost(req, mockRes.res);

      const exception = new UnauthorizedException('Authentication required');
      filter.catch(exception, host);

      expect(mockRes.statusCode).toBe(401);
      expect(mockRes.headers['content-type']).toBe('application/problem+json');
      const body = mockRes.jsonBody as ProblemDetails;
      expect(body.title).toBe('Unauthorized');
      expect(body.status).toBe(401);
      expect(body.detail).toBe('Authentication required');
    });

    it('should format 403 ForbiddenException as RFC 7807 Problem Details', () => {
      const req = createMockRequest({ path: '/v1/workspaces/w-123/docs', correlationId: 'corr-403' });
      const mockRes = createMockResponse();
      const host = createMockHost(req, mockRes.res);

      const exception = new ForbiddenException('Forbidden: Missing required capability [document:delete]');
      filter.catch(exception, host);

      expect(mockRes.statusCode).toBe(403);
      expect(mockRes.headers['content-type']).toBe('application/problem+json');
      const body = mockRes.jsonBody as ProblemDetails;
      expect(body.title).toBe('Forbidden');
      expect(body.status).toBe(403);
      expect(body.detail).toBe('Forbidden: Missing required capability [document:delete]');
    });

    it('should format 404 NotFoundException as RFC 7807 Problem Details (anti-enumeration)', () => {
      const req = createMockRequest({ path: '/v1/workspaces/a0000000-0000-0000-0000-000000000001', correlationId: 'corr-404' });
      const mockRes = createMockResponse();
      const host = createMockHost(req, mockRes.res);

      const exception = new NotFoundException('Workspace not found');
      filter.catch(exception, host);

      expect(mockRes.statusCode).toBe(404);
      expect(mockRes.headers['content-type']).toBe('application/problem+json');
      const body = mockRes.jsonBody as ProblemDetails;
      expect(body.title).toBe('Not Found');
      expect(body.status).toBe(404);
      expect(body.detail).toBe('Workspace not found');
      expect(body.instance).toBe('/v1/workspaces/a0000000-0000-0000-0000-000000000001');
    });

    it('should format 409 ConflictException as RFC 7807 Problem Details', () => {
      const req = createMockRequest({ path: '/v1/workspaces', correlationId: 'corr-409' });
      const mockRes = createMockResponse();
      const host = createMockHost(req, mockRes.res);

      const exception = new ConflictException('Workspace slug already in use');
      filter.catch(exception, host);

      expect(mockRes.statusCode).toBe(409);
      const body = mockRes.jsonBody as ProblemDetails;
      expect(body.title).toBe('Conflict');
      expect(body.status).toBe(409);
      expect(body.detail).toBe('Workspace slug already in use');
    });

    it('should format 422 UnprocessableEntityException as RFC 7807 Problem Details', () => {
      const req = createMockRequest({ path: '/v1/documents', correlationId: 'corr-422' });
      const mockRes = createMockResponse();
      const host = createMockHost(req, mockRes.res);

      const exception = new UnprocessableEntityException('Unable to parse document payload');
      filter.catch(exception, host);

      expect(mockRes.statusCode).toBe(422);
      const body = mockRes.jsonBody as ProblemDetails;
      expect(body.title).toBe('Unprocessable Entity');
      expect(body.status).toBe(422);
      expect(body.detail).toBe('Unable to parse document payload');
    });

    it('should sanitize unknown 500 Error and NEVER leak stack traces, database details, or raw error messages', () => {
      const req = createMockRequest({ path: '/v1/secret-query', correlationId: 'corr-500' });
      const mockRes = createMockResponse();
      const host = createMockHost(req, mockRes.res);

      const internalError = new Error('FATAL: connection to database server at 10.0.0.5:5432 failed; password authentication failed for user "postgres"');
      filter.catch(internalError, host);

      expect(mockRes.statusCode).toBe(500);
      expect(mockRes.headers['content-type']).toBe('application/problem+json');
      expect(mockRes.headers['x-correlation-id']).toBe('corr-500');

      const body = mockRes.jsonBody as ProblemDetails;
      expect(body.title).toBe('Internal Server Error');
      expect(body.status).toBe(500);
      expect(body.detail).toBe('An unexpected error occurred.');
      expect(body.correlation_id).toBe('corr-500');

      // Security Invariant Assertions:
      expect(JSON.stringify(body)).not.toContain('postgres');
      expect(JSON.stringify(body)).not.toContain('10.0.0.5');
      expect(JSON.stringify(body)).not.toContain('stack');
      expect(JSON.stringify(body)).not.toContain('password');
    });

    it('should handle non-Error thrown objects safely as 500 Internal Server Error', () => {
      const req = createMockRequest({ path: '/v1/crash' });
      const mockRes = createMockResponse();
      const host = createMockHost(req, mockRes.res);

      filter.catch('Some primitive string error', host);

      expect(mockRes.statusCode).toBe(500);
      const body = mockRes.jsonBody as ProblemDetails;
      expect(body.title).toBe('Internal Server Error');
      expect(body.status).toBe(500);
      expect(body.detail).toBe('An unexpected error occurred.');
    });

    it('should safely normalize validation error arrays from class-validator without dumping raw objects', () => {
      const req = createMockRequest({ path: '/v1/workspaces', correlationId: 'corr-val' });
      const mockRes = createMockResponse();
      const host = createMockHost(req, mockRes.res);

      // NestJS ValidationPipe produces { message: ['name should not be empty', 'slug must be a valid slug'] }
      const validationException = new BadRequestException({
        message: ['name should not be empty', 'slug must be a valid slug'],
        error: 'Bad Request',
        statusCode: 400,
      });

      filter.catch(validationException, host);

      expect(mockRes.statusCode).toBe(400);
      const body = mockRes.jsonBody as ProblemDetails;
      expect(body.title).toBe('Bad Request');
      expect(body.detail).toBe('name should not be empty; slug must be a valid slug');
      expect(body.errors).toEqual([
        { message: 'name should not be empty' },
        { message: 'slug must be a valid slug' },
      ]);
    });

    it('should sanitize instance by stripping sensitive query parameters from URL', () => {
      const req = createMockRequest({
        url: '/v1/documents?token=secret-token-123&api_key=secret-key',
        path: '',
        correlationId: 'corr-query',
      });
      const mockRes = createMockResponse();
      const host = createMockHost(req, mockRes.res);

      const exception = new NotFoundException('Document not found');
      filter.catch(exception, host);

      const body = mockRes.jsonBody as ProblemDetails;
      expect(body.instance).toBe('/v1/documents');
      expect(JSON.stringify(body)).not.toContain('secret-token');
      expect(JSON.stringify(body)).not.toContain('secret-key');
    });

    it('should prioritize correlation ID from RequestContext metadata when available', () => {
      const req = createMockRequest({ path: '/v1/test', correlationId: 'middleware-corr' });
      const ctx = createRequestContext({
        principal: { userId: 'u-1', organizationId: 'o-1', email: 'test@example.com' },
        metadata: { correlationId: 'context-corr-canonical', receivedAt: new Date() },
      });
      bindRequestContext(req, ctx);

      const mockRes = createMockResponse();
      const host = createMockHost(req, mockRes.res);

      filter.catch(new ForbiddenException('Access denied'), host);

      const body = mockRes.jsonBody as ProblemDetails;
      expect(body.correlation_id).toBe('context-corr-canonical');
      expect(mockRes.headers['x-correlation-id']).toBe('context-corr-canonical');
    });
  });
});

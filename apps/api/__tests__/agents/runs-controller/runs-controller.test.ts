import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  InternalServerErrorException,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { RunsController } from '../../../src/modules/agents/controllers/runs.controller.js';
import { RunsOrchestratorService } from '../../../src/modules/agents/services/runs-orchestrator.service.js';
import { CreateRunDto } from '../../../src/modules/agents/dto/create-run.dto.js';
import type { RunsOrchestratorResult } from '../../../src/modules/agents/services/runs-orchestrator.service.js';
import {
  createRequestContext,
} from '../../../src/modules/identity/interfaces/request-context.interface.js';
import type { RequestContext } from '../../../src/modules/identity/interfaces/request-context.interface.js';
import {
  bindRequestContext,
  getRequestContext,
} from '../../../src/modules/core/supabase/symbols.js';
import { ROLE_PERMISSIONS_MAP } from '../../../src/modules/workspace/interfaces/permissions.interface.js';
import { PERMISSIONS_KEY } from '../../../src/modules/workspace/decorators/require-permissions.decorator.js';
import { WorkspaceMemberGuard } from '../../../src/modules/workspace/guards/workspace-member.guard.js';
import { PermissionsGuard } from '../../../src/modules/workspace/guards/permissions.guard.js';

describe('N3.8-C7.3: RunsController & REST Route Invariants', () => {
  const validWsId = '33333333-3333-4333-a333-333333333333';
  const validThreadId = '55555555-5555-4555-a555-555555555555';
  const validUserId = '11111111-1111-4111-a111-111111111111';
  const validOrgId = '22222222-2222-4222-a222-222222222222';
  const correlationId = 'corr-7777-4777-a777-777777777777';
  const sampleQuery = 'What is the enterprise encryption standard?';

  let mockOrchestrator: RunsOrchestratorService;
  let controller: RunsController;
  let validationPipe: ValidationPipe;

  function buildAuthenticatedRequest(
    userId = validUserId,
    workspaceId = validWsId,
    role: keyof typeof ROLE_PERMISSIONS_MAP = 'contributor',
  ): Request {
    const req = {
      headers: { 'x-correlation-id': correlationId },
      params: { workspace_id: workspaceId, thread_id: validThreadId },
      query: {},
      body: {},
    } as unknown as Request;

    const ctx = createRequestContext({
      principal: {
        userId,
        organizationId: validOrgId,
        email: 'engineer@contexta.ai',
      },
      tenantScope: {
        workspaceId,
        organizationId: validOrgId,
        role,
        permissions: ROLE_PERMISSIONS_MAP[role],
      },
      metadata: {
        correlationId,
        receivedAt: new Date(),
      },
    });

    bindRequestContext(req, ctx);
    return req;
  }

  beforeEach(() => {
    jest.clearAllMocks();

    mockOrchestrator = {
      executeRun: jest.fn<any>(),
    } as unknown as RunsOrchestratorService;

    controller = new RunsController(mockOrchestrator);

    validationPipe = new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    });
  });

  // =========================================================================
  // 1. DTO VALIDATION & SECURITY REJECTIONS
  // =========================================================================
  describe('CreateRunDto Validation & Security Invariants', () => {
    it('accepts valid run payload with query', async () => {
      const payload = { query: sampleQuery };
      const transformed = await validationPipe.transform(payload, {
        type: 'body',
        metatype: CreateRunDto,
      });

      expect(transformed.query).toBe(sampleQuery);
    });

    it('accepts valid run payload with query and parameters object', async () => {
      const payload = {
        query: sampleQuery,
        parameters: { search_mode: 'hybrid', top_k: 20 },
      };
      const transformed = await validationPipe.transform(payload, {
        type: 'body',
        metatype: CreateRunDto,
      });

      expect(transformed.query).toBe(sampleQuery);
      expect(transformed.parameters).toEqual({ search_mode: 'hybrid', top_k: 20 });
    });

    it('rejects missing query with 400 BadRequestException', async () => {
      const payload = {};
      await expect(
        validationPipe.transform(payload, { type: 'body', metatype: CreateRunDto }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects empty query string with 400 BadRequestException', async () => {
      const payload = { query: '' };
      await expect(
        validationPipe.transform(payload, { type: 'body', metatype: CreateRunDto }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects whitespace-only query string with 400 BadRequestException', async () => {
      const payload = { query: '    ' };
      await expect(
        validationPipe.transform(payload, { type: 'body', metatype: CreateRunDto }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects non-string query with 400 BadRequestException', async () => {
      const payload = { query: 12345 };
      await expect(
        validationPipe.transform(payload, { type: 'body', metatype: CreateRunDto }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects query exceeding 10000 characters with 400 BadRequestException', async () => {
      const payload = { query: 'a'.repeat(10001) };
      await expect(
        validationPipe.transform(payload, { type: 'body', metatype: CreateRunDto }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects non-object parameters with 400 BadRequestException', async () => {
      const payload = { query: sampleQuery, parameters: 'invalid_string' };
      await expect(
        validationPipe.transform(payload, { type: 'body', metatype: CreateRunDto }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects unknown security-sensitive property "userId" (forbidNonWhitelisted)', async () => {
      const payload = { query: sampleQuery, userId: validUserId };
      await expect(
        validationPipe.transform(payload, { type: 'body', metatype: CreateRunDto }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects unknown security-sensitive property "workspaceId" (forbidNonWhitelisted)', async () => {
      const payload = { query: sampleQuery, workspaceId: validWsId };
      await expect(
        validationPipe.transform(payload, { type: 'body', metatype: CreateRunDto }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects unknown security-sensitive property "role" (forbidNonWhitelisted)', async () => {
      const payload = { query: sampleQuery, role: 'org_admin' };
      await expect(
        validationPipe.transform(payload, { type: 'body', metatype: CreateRunDto }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects unknown security-sensitive property "authToken" (forbidNonWhitelisted)', async () => {
      const payload = { query: sampleQuery, authToken: 'Bearer eyJ...' };
      await expect(
        validationPipe.transform(payload, { type: 'body', metatype: CreateRunDto }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects unknown property "agentState" (forbidNonWhitelisted)', async () => {
      const payload = { query: sampleQuery, agentState: {} };
      await expect(
        validationPipe.transform(payload, { type: 'body', metatype: CreateRunDto }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // =========================================================================
  // 2. CONTROLLER UNIT EXECUTION & RESPONSE MAPPING
  // =========================================================================
  describe('RunsController Execution & Response Mapping', () => {
    it('executes completed run and returns ADR-0006 compliant JSON envelope', async () => {
      const req = buildAuthenticatedRequest();
      const mockResult: RunsOrchestratorResult = {
        runId: '66666666-6666-4666-a666-666666666666',
        threadId: validThreadId,
        workspaceId: validWsId,
        status: 'completed',
        finalResponse: 'Enterprise standard is AES-256.',
        citations: [
          {
            id: 'cit-1',
            claimText: 'Enterprise standard is AES-256.',
            citedChunkIds: ['chunk-1'],
            entailmentScore: 0.96,
            status: 'SUPPORTED',
            sourceDocumentId: 'doc-1',
            pageNumber: 4,
          },
        ],
        verificationScore: 0.96,
        initiatingMessageId: 'msg-user-1',
        assistantMessageId: 'msg-asst-1',
        startedAt: new Date('2026-09-23T00:00:00.000Z'),
        completedAt: new Date('2026-09-23T00:00:02.000Z'),
      };

      (mockOrchestrator.executeRun as jest.Mock<any>).mockResolvedValueOnce(mockResult);

      const response = await controller.createRun(
        validWsId,
        validThreadId,
        { query: sampleQuery },
        req,
      );

      expect(mockOrchestrator.executeRun).toHaveBeenCalledTimes(1);
      expect(mockOrchestrator.executeRun).toHaveBeenCalledWith(
        {
          threadId: validThreadId,
          query: sampleQuery,
          parameters: undefined,
        },
        getRequestContext(req),
        expect.anything(),
      );

      expect(response.error).toBeNull();
      expect(response.meta.request_id).toBe(correlationId);
      expect(response.data).toEqual({
        id: '66666666-6666-4666-a666-666666666666',
        thread_id: validThreadId,
        workspace_id: validWsId,
        status: 'completed',
        final_response: 'Enterprise standard is AES-256.',
        citations: [
          {
            id: 'cit-1',
            claim_text: 'Enterprise standard is AES-256.',
            source_document_id: 'doc-1',
            page_number: 4,
            entailment_score: 0.96,
            verification_status: 'SUPPORTED',
          },
        ],
        started_at: '2026-09-23T00:00:00.000Z',
        completed_at: '2026-09-23T00:00:02.000Z',
      });
    });

    it('executes declined_uncertain run and returns 200 response with uncertainty content', async () => {
      const req = buildAuthenticatedRequest();
      const mockResult: RunsOrchestratorResult = {
        runId: '66666666-6666-4666-a666-666666666666',
        threadId: validThreadId,
        workspaceId: validWsId,
        status: 'declined_uncertain',
        finalResponse: 'I am unable to provide a verified answer based on retrieved context.',
        citations: [],
        verificationScore: 0.45,
        initiatingMessageId: 'msg-user-1',
        assistantMessageId: 'msg-asst-1',
        startedAt: new Date('2026-09-23T00:00:00.000Z'),
        completedAt: new Date('2026-09-23T00:00:02.000Z'),
      };

      (mockOrchestrator.executeRun as jest.Mock<any>).mockResolvedValueOnce(mockResult);

      const response = await controller.createRun(
        validWsId,
        validThreadId,
        { query: sampleQuery },
        req,
      );

      expect(response.data.status).toBe('declined_uncertain');
      expect(response.data.final_response).toContain('unable to provide a verified answer');
      expect(response.error).toBeNull();
    });

    it('throws InternalServerErrorException when orchestrator returns status failed', async () => {
      const req = buildAuthenticatedRequest();
      const mockResult: RunsOrchestratorResult = {
        runId: '66666666-6666-4666-a666-666666666666',
        threadId: validThreadId,
        workspaceId: validWsId,
        status: 'failed',
        startedAt: new Date(),
        error: {
          code: 'EXECUTION_FAILED',
          message: 'Upstream provider outage',
        },
      };

      (mockOrchestrator.executeRun as jest.Mock<any>).mockResolvedValueOnce(mockResult);

      await expect(
        controller.createRun(validWsId, validThreadId, { query: sampleQuery }, req),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('throws BadRequestException when orchestrator returns status cancelled', async () => {
      const req = buildAuthenticatedRequest();
      const mockResult: RunsOrchestratorResult = {
        runId: '66666666-6666-4666-a666-666666666666',
        threadId: validThreadId,
        workspaceId: validWsId,
        status: 'cancelled',
        startedAt: new Date(),
        error: {
          code: 'EXECUTION_CANCELLED',
          message: 'Run execution was cancelled',
        },
      };

      (mockOrchestrator.executeRun as jest.Mock<any>).mockResolvedValueOnce(mockResult);

      await expect(
        controller.createRun(validWsId, validThreadId, { query: sampleQuery }, req),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws UnauthorizedException when request lacks RequestContext', async () => {
      const unauthReq = { headers: {}, params: {}, query: {}, body: {} } as unknown as Request;

      await expect(
        controller.createRun(validWsId, validThreadId, { query: sampleQuery }, unauthReq),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  // =========================================================================
  // 3. GUARD PIPELINE & RBAC DECORATOR CONTRACT
  // =========================================================================
  describe('Guard Pipeline & RBAC Permissions Metadata', () => {
    it('declares @RequirePermissions("run:execute") on createRun method', () => {
      const reflector = new Reflector();
      const permissions = reflector.get<string[]>(PERMISSIONS_KEY, RunsController.prototype.createRun);

      expect(permissions).toBeDefined();
      expect(permissions).toEqual(['run:execute']);
    });

    it('allows role contributor with run:execute permission via PermissionsGuard', () => {
      const reflector = new Reflector();
      const permissionsGuard = new PermissionsGuard(reflector);

      const req = buildAuthenticatedRequest(validUserId, validWsId, 'contributor');
      const mockContext = {
        switchToHttp: () => ({ getRequest: () => req }),
        getHandler: () => RunsController.prototype.createRun,
        getClass: () => RunsController,
      } as any;

      const canActivate = permissionsGuard.canActivate(mockContext);
      expect(canActivate).toBe(true);
    });

    it('allows role workspace_admin with run:execute permission via PermissionsGuard', () => {
      const reflector = new Reflector();
      const permissionsGuard = new PermissionsGuard(reflector);

      const req = buildAuthenticatedRequest(validUserId, validWsId, 'workspace_admin');
      const mockContext = {
        switchToHttp: () => ({ getRequest: () => req }),
        getHandler: () => RunsController.prototype.createRun,
        getClass: () => RunsController,
      } as any;

      const canActivate = permissionsGuard.canActivate(mockContext);
      expect(canActivate).toBe(true);
    });

    it('rejects role viewer lacking run:execute permission via PermissionsGuard with 403 Forbidden', () => {
      const reflector = new Reflector();
      const permissionsGuard = new PermissionsGuard(reflector);

      const req = buildAuthenticatedRequest(validUserId, validWsId, 'viewer');
      const mockContext = {
        switchToHttp: () => ({ getRequest: () => req }),
        getHandler: () => RunsController.prototype.createRun,
        getClass: () => RunsController,
      } as any;

      expect(() => permissionsGuard.canActivate(mockContext)).toThrow(ForbiddenException);
    });

    it('enforces WorkspaceMemberGuard anti-enumeration (404 Not Found) for non-members', async () => {
      const mockMembershipProvider = {
        findMembership: jest.fn<any>().mockResolvedValue(null),
      };

      const memberGuard = new WorkspaceMemberGuard(undefined, mockMembershipProvider);

      const req = {
        params: { workspace_id: validWsId, thread_id: validThreadId },
        headers: {},
      } as unknown as Request;

      const unauthCtx = createRequestContext({
        principal: { userId: validUserId, organizationId: validOrgId, email: 'user@test.com' },
        metadata: { correlationId, receivedAt: new Date() },
      });
      bindRequestContext(req, unauthCtx);

      const mockContext = {
        switchToHttp: () => ({ getRequest: () => req }),
      } as any;

      await expect(memberGuard.canActivate(mockContext)).rejects.toThrow(NotFoundException);
    });
  });
});

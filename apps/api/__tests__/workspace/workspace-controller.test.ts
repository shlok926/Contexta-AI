import { jest } from '@jest/globals';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
  InternalServerErrorException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { WorkspaceController } from '../../src/modules/workspace/controllers/workspace.controller.js';
import { WorkspaceService } from '../../src/modules/workspace/services/workspace.service.js';
import { CreateWorkspaceDto } from '../../src/modules/workspace/dto/create-workspace.dto.js';
import { createRequestExecutionContext } from '../../src/modules/core/interfaces/request-execution-context.interface.js';
import {
  createRequestContext,
} from '../../src/modules/identity/interfaces/request-context.interface.js';
import {
  bindRequestContext,
  getRequestContext,
} from '../../src/modules/core/supabase/symbols.js';
import { ROLE_PERMISSIONS_MAP } from '../../src/modules/workspace/interfaces/permissions.interface.js';
import { PERMISSIONS_KEY } from '../../src/modules/workspace/decorators/require-permissions.decorator.js';
import { WorkspaceBootstrapGuard } from '../../src/modules/workspace/guards/workspace-bootstrap.guard.js';
import { WorkspaceMemberGuard } from '../../src/modules/workspace/guards/workspace-member.guard.js';
import { PermissionsGuard } from '../../src/modules/workspace/guards/permissions.guard.js';

// Initialize test environment configuration before any module imports
process.env.NODE_ENV = 'test';
process.env.PORT = '3000';
process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key-min-10-chars';
process.env.JWT_VERIFICATION_PROFILE = 'symmetric';
process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret-with-at-least-32-chars-long';

describe('N2.9 NestJS Workspace Controller & Route Composition', () => {
  const validWsIdA = 'a0000000-0000-0000-0000-000000000001';
  const validWsIdB = 'b0000000-0000-0000-0000-000000000002';
  const sampleUserId = 'u0000000-0000-0000-0000-000000000001';
  const sampleOrgId = 'o0000000-0000-0000-0000-000000000001';

  function setupAuthenticatedRequest(
    userId = sampleUserId,
    orgId = sampleOrgId,
  ): Request {
    const req = {
      headers: {},
      params: {},
      query: {},
      body: {},
    } as unknown as Request;

    const ctx = createRequestContext({
      principal: { userId, organizationId: orgId, email: 'user@example.com' },
      metadata: { correlationId: 'corr-ws-123', receivedAt: new Date() },
    });

    bindRequestContext(req, ctx);
    return req;
  }

  // =========================================================================
  // 1. WORKSPACE SERVICE UNIT & RPC TESTS
  // =========================================================================
  describe('WorkspaceService', () => {
    let service: WorkspaceService;
    let mockSupabaseClient: {
      rpc: jest.Mock<any>;
      from: jest.Mock<any>;
    };
    let mockSupabaseService: {
      getClient: jest.Mock<any>;
    };

    beforeEach(() => {
      mockSupabaseClient = {
        rpc: jest.fn<any>(),
        from: jest.fn<any>(),
      };
      mockSupabaseService = {
        getClient: jest.fn<any>().mockReturnValue(mockSupabaseClient),
      };
      service = new WorkspaceService(undefined, mockSupabaseService as any);
    });

    describe('bootstrapWorkspace()', () => {
      it('should invoke bootstrap_workspace RPC with p_name and return generated workspace ID', async () => {
        const req = setupAuthenticatedRequest();
        const execContext = createRequestExecutionContext(req);

        mockSupabaseClient.rpc.mockResolvedValueOnce({
          data: validWsIdA,
          error: null,
        });

        const dto: CreateWorkspaceDto = { name: 'Engineering Core' };
        const result = await service.bootstrapWorkspace(dto, execContext);

        expect(result).toEqual({ id: validWsIdA });
        expect(mockSupabaseClient.rpc).toHaveBeenCalledWith('bootstrap_workspace', {
          p_name: 'Engineering Core',
        });
      });

      it('should reject empty or whitespace-only workspace name with 400 BadRequestException', async () => {
        const req = setupAuthenticatedRequest();
        const execContext = createRequestExecutionContext(req);

        const dto: CreateWorkspaceDto = { name: '   ' };
        await expect(service.bootstrapWorkspace(dto, execContext)).rejects.toThrow(BadRequestException);
        expect(mockSupabaseClient.rpc).not.toHaveBeenCalled();
      });

      it('should map RPC error 42501 to 403 ForbiddenException', async () => {
        const req = setupAuthenticatedRequest();
        const execContext = createRequestExecutionContext(req);

        mockSupabaseClient.rpc.mockResolvedValueOnce({
          data: null,
          error: { code: '42501', message: 'FORBIDDEN: Caller must hold org_admin role' },
        });

        const dto: CreateWorkspaceDto = { name: 'Secured Workspace' };
        await expect(service.bootstrapWorkspace(dto, execContext)).rejects.toThrow(ForbiddenException);
      });

      it('should map RPC error 22023 to 400 BadRequestException', async () => {
        const req = setupAuthenticatedRequest();
        const execContext = createRequestExecutionContext(req);

        mockSupabaseClient.rpc.mockResolvedValueOnce({
          data: null,
          error: { code: '22023', message: 'INVALID_PARAMETER: Workspace name exceeds maximum length' },
        });

        const dto: CreateWorkspaceDto = { name: 'Valid Client Length But DB Rejected' };
        await expect(service.bootstrapWorkspace(dto, execContext)).rejects.toThrow(BadRequestException);
      });

      it('should map RPC error 23505 to 409 ConflictException', async () => {
        const req = setupAuthenticatedRequest();
        const execContext = createRequestExecutionContext(req);

        mockSupabaseClient.rpc.mockResolvedValueOnce({
          data: null,
          error: { code: '23505', message: 'unique constraint violation' },
        });

        const dto: CreateWorkspaceDto = { name: 'Duplicate Workspace' };
        await expect(service.bootstrapWorkspace(dto, execContext)).rejects.toThrow(ConflictException);
      });

      it('should propagate unexpected database errors as-is for N2.8 HttpExceptionFilter sanitization', async () => {
        const req = setupAuthenticatedRequest();
        const execContext = createRequestExecutionContext(req);

        const unexpectedDbError = new Error('FATAL: connection terminated unexpectedly');
        mockSupabaseClient.rpc.mockResolvedValueOnce({
          data: null,
          error: unexpectedDbError,
        });

        const dto: CreateWorkspaceDto = { name: 'Valid Workspace' };
        await expect(service.bootstrapWorkspace(dto, execContext)).rejects.toThrow(unexpectedDbError);
      });
    });

    describe('getWorkspace()', () => {
      it('should query workspaces table by id under active RLS and return standardized response', async () => {
        const req = setupAuthenticatedRequest();
        const execContext = createRequestExecutionContext(req);

        const mockSelectQuery = {
          select: jest.fn<any>().mockReturnThis(),
          eq: jest.fn<any>().mockReturnThis(),
          single: jest.fn<any>().mockResolvedValueOnce({
            data: {
              id: validWsIdA,
              organization_id: sampleOrgId,
              name: 'Production Core',
              description: 'Primary workspace',
              retention_policy: 'standard',
              created_at: '2026-09-19T20:00:00.000Z',
              updated_at: '2026-09-19T20:00:00.000Z',
            },
            error: null,
          }),
        };

        mockSupabaseClient.from.mockReturnValueOnce(mockSelectQuery);

        const result = await service.getWorkspace(validWsIdA, execContext);

        expect(mockSupabaseClient.from).toHaveBeenCalledWith('workspaces');
        expect(mockSelectQuery.select).toHaveBeenCalledWith(
          'id, organization_id, name, description, retention_policy, created_at, updated_at',
        );
        expect(mockSelectQuery.eq).toHaveBeenCalledWith('id', validWsIdA);
        expect(result).toEqual({
          id: validWsIdA,
          organizationId: sampleOrgId,
          name: 'Production Core',
          description: 'Primary workspace',
          retentionPolicy: 'standard',
          createdAt: '2026-09-19T20:00:00.000Z',
          updatedAt: '2026-09-19T20:00:00.000Z',
        });
      });

      it('should fail with 404 NotFoundException when workspace is not found or hidden by RLS', async () => {
        const req = setupAuthenticatedRequest();
        const execContext = createRequestExecutionContext(req);

        const mockSelectQuery = {
          select: jest.fn<any>().mockReturnThis(),
          eq: jest.fn<any>().mockReturnThis(),
          single: jest.fn<any>().mockResolvedValue({
            data: null,
            error: { code: 'PGRST116', message: 'The result contains 0 rows' },
          }),
        };

        mockSupabaseClient.from.mockReturnValue(mockSelectQuery);

        await expect(service.getWorkspace(validWsIdA, execContext)).rejects.toThrow(NotFoundException);
        await expect(service.getWorkspace(validWsIdA, execContext)).rejects.toThrow(/Workspace not found/);
      });
    });
  });

  // =========================================================================
  // 2. WORKSPACE CONTROLLER DECLARATIVE METADATA & GUARD WIRING
  // =========================================================================
  describe('WorkspaceController Metadata & Route Composition', () => {
    let controller: WorkspaceController;
    let mockService: jest.Mocked<WorkspaceService>;
    const reflector = new Reflector();

    beforeEach(() => {
      mockService = {
        bootstrapWorkspace: jest.fn(),
        getWorkspace: jest.fn(),
      } as unknown as jest.Mocked<WorkspaceService>;
      controller = new WorkspaceController(mockService);
    });

    it('should declare @RequirePermissions(workspace:read) on GET :workspace_id handler', () => {
      const perms = reflector.get<string[]>(PERMISSIONS_KEY, controller.getWorkspace);
      expect(perms).toEqual(['workspace:read']);
    });

    it('should NOT declare @RequirePermissions on POST createWorkspace handler (bootstrap deadlock exception)', () => {
      const perms = reflector.get<string[] | undefined>(PERMISSIONS_KEY, controller.createWorkspace);
      expect(perms).toBeUndefined();
    });

    it('should delegate POST /v1/workspaces to WorkspaceService.bootstrapWorkspace', async () => {
      const req = setupAuthenticatedRequest();
      const dto: CreateWorkspaceDto = { name: 'Alpha Project' };

      mockService.bootstrapWorkspace.mockResolvedValueOnce({ id: validWsIdA });

      const response = await controller.createWorkspace(dto, req);

      expect(response).toEqual({ id: validWsIdA });
      expect(mockService.bootstrapWorkspace).toHaveBeenCalledWith(
        dto,
        expect.objectContaining({ rawRequest: req }),
      );
    });

    it('should delegate GET /v1/workspaces/:workspace_id to WorkspaceService.getWorkspace', async () => {
      const req = setupAuthenticatedRequest();

      mockService.getWorkspace.mockResolvedValueOnce({
        id: validWsIdA,
        organizationId: sampleOrgId,
        name: 'Alpha Project',
        description: null,
        retentionPolicy: 'standard',
        createdAt: '2026-09-19T20:00:00.000Z',
        updatedAt: '2026-09-19T20:00:00.000Z',
      });

      const response = await controller.getWorkspace(validWsIdA, req);

      expect(response.id).toBe(validWsIdA);
      expect(response.name).toBe('Alpha Project');
      expect(mockService.getWorkspace).toHaveBeenCalledWith(
        validWsIdA,
        expect.objectContaining({ rawRequest: req }),
      );
    });
  });

  // =========================================================================
  // 3. COMPLETE PIPELINE INTEGRATION & IDOR DEFENSE
  // =========================================================================
  describe('Full Guard Pipeline Integration & IDOR Verification', () => {
    let mockMembershipProvider: {
      findMembership: jest.Mock<any>;
    };
    let mockBootstrapProvider: {
      getUserMemberships: jest.Mock<any>;
    };
    let memberGuard: WorkspaceMemberGuard;
    let bootstrapGuard: WorkspaceBootstrapGuard;
    let permissionsGuard: PermissionsGuard;
    let controller: WorkspaceController;
    let mockService: {
      bootstrapWorkspace: jest.Mock<any>;
      getWorkspace: jest.Mock<any>;
    };
    let reflector: Reflector;

    beforeEach(() => {
      reflector = new Reflector();
      mockMembershipProvider = {
        findMembership: jest.fn<any>(),
      };
      mockBootstrapProvider = {
        getUserMemberships: jest.fn<any>(),
      };

      memberGuard = new WorkspaceMemberGuard(mockMembershipProvider as any);
      bootstrapGuard = new WorkspaceBootstrapGuard(mockBootstrapProvider as any);
      permissionsGuard = new PermissionsGuard(reflector);

      mockService = {
        bootstrapWorkspace: jest.fn<any>(),
        getWorkspace: jest.fn<any>(),
      };

      controller = new WorkspaceController(mockService as any);
    });

    function createMockExecutionContext(
      req: Request,
      handler: (...args: unknown[]) => unknown,
    ) {
      return {
        switchToHttp: () => ({
          getRequest: () => req,
          getResponse: () => ({}),
          getNext: () => ({}),
        }),
        getHandler: () => handler,
        getClass: () => WorkspaceController,
        getArgs: () => [],
        getArgByIndex: () => ({}),
        switchToRpc: () => ({}) as never,
        switchToWs: () => ({}) as never,
        getType: () => 'http',
      } as any;
    }

    // Pipeline runner for GET /v1/workspaces/:workspace_id
    async function executeGetPipeline(req: Request, workspaceId: string) {
      (req as any).params = { workspace_id: workspaceId };
      const execCtx = createMockExecutionContext(req, controller.getWorkspace);

      // 1. Layer 2: WorkspaceMemberGuard
      const memberAllowed = await memberGuard.canActivate(execCtx);
      if (!memberAllowed) return false;

      // 2. Layer 3: PermissionsGuard
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['workspace:read']);
      const permsAllowed = permissionsGuard.canActivate(execCtx);
      if (!permsAllowed) return false;

      // 3. Controller
      return controller.getWorkspace(workspaceId, req);
    }

    // Pipeline runner for POST /v1/workspaces
    async function executePostPipeline(req: Request, dto: CreateWorkspaceDto) {
      const execCtx = createMockExecutionContext(req, controller.createWorkspace);

      // 1. Layer 2: WorkspaceBootstrapGuard
      const bootstrapAllowed = await bootstrapGuard.canActivate(execCtx);
      if (!bootstrapAllowed) return false;

      // 2. Controller
      return controller.createWorkspace(dto, req);
    }

    it('should allow POST bootstrap for caller with 0 visible workspaces', async () => {
      const req = setupAuthenticatedRequest('user-fresh', sampleOrgId);
      mockBootstrapProvider.getUserMemberships.mockResolvedValueOnce([]);
      mockService.bootstrapWorkspace.mockResolvedValueOnce({ id: validWsIdA });

      const result = await executePostPipeline(req, { name: 'My First Workspace' });
      expect(result).toEqual({ id: validWsIdA });
      expect(mockService.bootstrapWorkspace).toHaveBeenCalledTimes(1);
    });

    it('should allow POST bootstrap for caller with existing workspaces when user is org_admin', async () => {
      const req = setupAuthenticatedRequest('user-admin', sampleOrgId);
      mockBootstrapProvider.getUserMemberships.mockResolvedValueOnce([
        { workspaceId: validWsIdA, role: 'org_admin' },
      ]);
      mockService.bootstrapWorkspace.mockResolvedValueOnce({ id: validWsIdB });

      const result = await executePostPipeline(req, { name: 'Second Workspace' });
      expect(result).toEqual({ id: validWsIdB });
    });

    it('should reject POST bootstrap for caller with existing workspaces who is NOT org_admin (403)', async () => {
      const req = setupAuthenticatedRequest('user-contributor', sampleOrgId);
      mockBootstrapProvider.getUserMemberships.mockResolvedValue([
        { workspaceId: validWsIdA, role: 'contributor' },
      ]);

      await expect(
        executePostPipeline(req, { name: 'Unauthorized Workspace' }),
      ).rejects.toThrow(ForbiddenException);

      expect(mockService.bootstrapWorkspace).not.toHaveBeenCalled();
    });

    it('should allow GET /v1/workspaces/:workspace_id for authorized workspace member', async () => {
      const req = setupAuthenticatedRequest('user-member', sampleOrgId);
      mockMembershipProvider.findMembership.mockResolvedValueOnce({
        workspaceId: validWsIdA,
        userId: 'user-member',
        role: 'viewer', // viewer has workspace:read capability
      });

      mockService.getWorkspace.mockResolvedValueOnce({
        id: validWsIdA,
        organizationId: sampleOrgId,
        name: 'Workspace A',
        description: null,
        retentionPolicy: 'standard',
        createdAt: '2026-09-19T20:00:00.000Z',
        updatedAt: '2026-09-19T20:00:00.000Z',
      });

      const res = await executeGetPipeline(req, validWsIdA);
      expect((res as any).id).toBe(validWsIdA);
      expect((res as any).name).toBe('Workspace A');
    });

    it('should enforce IDOR protection: User A cannot access Workspace B (fails closed with 404 anti-enumeration)', async () => {
      // User A is member of Workspace A ONLY
      const reqA = setupAuthenticatedRequest('user-A', sampleOrgId);

      // User A queries Workspace B -> database returns null
      mockMembershipProvider.findMembership.mockResolvedValueOnce(null);

      await expect(executeGetPipeline(reqA, validWsIdB)).rejects.toThrow(NotFoundException);
      expect(mockService.getWorkspace).not.toHaveBeenCalled();
    });

    it('should enforce IDOR protection: User B cannot access Workspace A (fails closed with 404 anti-enumeration)', async () => {
      // User B is member of Workspace B ONLY
      const reqB = setupAuthenticatedRequest('user-B', sampleOrgId);

      // User B queries Workspace A -> database returns null
      mockMembershipProvider.findMembership.mockResolvedValueOnce(null);

      await expect(executeGetPipeline(reqB, validWsIdA)).rejects.toThrow(NotFoundException);
      expect(mockService.getWorkspace).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 4. DTO VALIDATION & UNKNOWN PROPERTY REJECTION (ValidationPipe)
  // =========================================================================
  describe('CreateWorkspaceDto Validation & Security Invariants', () => {
    const validationPipe = new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    const metadata = {
      type: 'body' as const,
      metatype: CreateWorkspaceDto,
      data: '',
    };

    it('should accept valid workspace creation payload', async () => {
      const payload = { name: 'Contexta Engineering' };
      const dto = await validationPipe.transform(payload, metadata);
      expect(dto).toBeInstanceOf(CreateWorkspaceDto);
      expect(dto.name).toBe('Contexta Engineering');
    });

    it('should reject payload with unknown "role" property with 400 BadRequestException', async () => {
      const malicious = { name: 'Workspace', role: 'org_admin' };
      await expect(validationPipe.transform(malicious, metadata)).rejects.toThrow(BadRequestException);
    });

    it('should reject payload with unknown "permissions" property with 400 BadRequestException', async () => {
      const malicious = { name: 'Workspace', permissions: ['workspace:create', 'workspace:delete'] };
      await expect(validationPipe.transform(malicious, metadata)).rejects.toThrow(BadRequestException);
    });

    it('should reject payload with unknown "organization_id" property with 400 BadRequestException', async () => {
      const malicious = { name: 'Workspace', organization_id: 'forged-org-uuid' };
      await expect(validationPipe.transform(malicious, metadata)).rejects.toThrow(BadRequestException);
    });

    it('should reject payload with unknown "user_id" property with 400 BadRequestException', async () => {
      const malicious = { name: 'Workspace', user_id: 'forged-user-uuid' };
      await expect(validationPipe.transform(malicious, metadata)).rejects.toThrow(BadRequestException);
    });

    it('should reject payload with unknown "owner_id" property with 400 BadRequestException', async () => {
      const malicious = { name: 'Workspace', owner_id: 'forged-owner-uuid' };
      await expect(validationPipe.transform(malicious, metadata)).rejects.toThrow(BadRequestException);
    });

    it('should reject payload with unknown "created_by" property with 400 BadRequestException', async () => {
      const malicious = { name: 'Workspace', created_by: 'attacker' };
      await expect(validationPipe.transform(malicious, metadata)).rejects.toThrow(BadRequestException);
    });

    it('should reject missing name with 400 BadRequestException', async () => {
      const invalid = {};
      await expect(validationPipe.transform(invalid, metadata)).rejects.toThrow(BadRequestException);
    });

    it('should reject empty name with 400 BadRequestException', async () => {
      const invalid = { name: '' };
      await expect(validationPipe.transform(invalid, metadata)).rejects.toThrow(BadRequestException);
    });

    it('should reject name exceeding 255 characters with 400 BadRequestException', async () => {
      const invalid = { name: 'x'.repeat(256) };
      await expect(validationPipe.transform(invalid, metadata)).rejects.toThrow(BadRequestException);
    });

    it('should reject non-string numeric name with 400 BadRequestException', async () => {
      const invalid = { name: 12345 };
      await expect(validationPipe.transform(invalid, metadata)).rejects.toThrow(BadRequestException);
    });

    it('should reject null name with 400 BadRequestException', async () => {
      const invalid = { name: null };
      await expect(validationPipe.transform(invalid, metadata)).rejects.toThrow(BadRequestException);
    });

    it('should reject array name with 400 BadRequestException', async () => {
      const invalid = { name: ['invalid', 'array'] };
      await expect(validationPipe.transform(invalid, metadata)).rejects.toThrow(BadRequestException);
    });
  });

  // =========================================================================
  // 5. REAL NESTJS HTTP ROUTE COMPOSITION & ROUTE QUARANTINE
  // =========================================================================
  describe('NestJS Real HTTP Route Composition & Route Quarantine', () => {
    let app: any;
    let baseUrl: string;

    beforeAll(async () => {
      process.env.NODE_ENV = 'test';
      process.env.PORT = '3000';
      process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
      process.env.SUPABASE_ANON_KEY = 'test-anon-key-min-10-chars';
      process.env.JWT_VERIFICATION_PROFILE = 'symmetric';
      process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret-with-at-least-32-chars-long';

      const { Test } = await import('@nestjs/testing');
      const { AppModule } = await import('../../src/app.module.js');

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = moduleRef.createNestApplication();
      await app.init();
      await app.listen(0);

      const address = app.getHttpServer().address();
      const port = typeof address === 'string' ? address : address?.port;
      baseUrl = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
      if (app) {
        await app.close();
      }
    });

    it('should expose POST /v1/workspaces and fail closed with 401 when unauthenticated', async () => {
      const res = await fetch(`${baseUrl}/v1/workspaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Unauthenticated Workspace' }),
      });

      expect(res.status).toBe(401);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      expect(res.headers.get('x-correlation-id')).toBeDefined();

      const body = (await res.json()) as any;
      expect(body.status).toBe(401);
      expect(body.type).toBe('about:blank');
    });

    it('should expose GET /v1/workspaces/:workspace_id and fail closed with 401 when unauthenticated', async () => {
      const res = await fetch(`${baseUrl}/v1/workspaces/${validWsIdA}`, {
        method: 'GET',
      });

      expect(res.status).toBe(401);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      expect(res.headers.get('x-correlation-id')).toBeDefined();

      const body = (await res.json()) as any;
      expect(body.status).toBe(401);
      expect(body.type).toBe('about:blank');
    });

    it('should propagate correlation ID across real HTTP request/response cycle', async () => {
      const customCorrelationId = 'client-custom-corr-id-999';
      const res = await fetch(`${baseUrl}/v1/workspaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Correlation-ID': customCorrelationId,
        },
        body: JSON.stringify({ name: 'Correlated Workspace' }),
      });

      expect(res.headers.get('x-correlation-id')).toBe(customCorrelationId);
    });

    it('should verify route quarantine: only NestJS WorkspaceController is registered and no duplicate routes exist', () => {
      const server = app.getHttpServer();
      const router = server._events.request._router;
      
      // Collect registered route paths
      const registeredRoutes: { path: string; methods: string[] }[] = [];
      
      if (router && router.stack) {
        for (const layer of router.stack) {
          if (layer.route) {
            registeredRoutes.push({
              path: layer.route.path,
              methods: Object.keys(layer.route.methods),
            });
          }
        }
      }

      // Verify that /v1/workspaces exists in the real route table
      const postWorkspaceRoutes = registeredRoutes.filter(
        (r) => r.path === '/v1/workspaces' && r.methods.includes('post'),
      );
      const getWorkspaceRoutes = registeredRoutes.filter(
        (r) => r.path === '/v1/workspaces/:workspace_id' && r.methods.includes('get'),
      );

      // Exactly 1 canonical POST route and 1 canonical GET route
      expect(postWorkspaceRoutes.length).toBe(1);
      expect(getWorkspaceRoutes.length).toBe(1);
    });
  });
});

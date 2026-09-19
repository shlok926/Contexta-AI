import { jest } from '@jest/globals';
import {
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  type Permission,
  type PermissionsMap,
  ROLE_PERMISSIONS_MAP,
  hasPermission,
} from '../../src/modules/workspace/interfaces/permissions.interface.js';
import {
  type WorkspaceRole,
  WORKSPACE_ROLES,
} from '../../src/modules/workspace/interfaces/roles.interface.js';
import {
  RequirePermissions,
  PERMISSIONS_KEY,
} from '../../src/modules/workspace/decorators/require-permissions.decorator.js';
import { PermissionsGuard } from '../../src/modules/workspace/guards/permissions.guard.js';
import {
  WorkspaceMemberGuard,
  type WorkspaceMembershipProvider,
  type WorkspaceMembership,
} from '../../src/modules/workspace/guards/workspace-member.guard.js';
import {
  WorkspaceBootstrapGuard,
  type WorkspaceBootstrapProvider,
  type WorkspaceBootstrapMembership,
} from '../../src/modules/workspace/guards/workspace-bootstrap.guard.js';
import {
  createRequestContext,
  type RequestContext,
} from '../../src/modules/identity/interfaces/request-context.interface.js';
import {
  bindRequestContext,
  getRequestContext,
} from '../../src/modules/core/supabase/symbols.js';

describe('N2.5 RBAC + Workspace Authorization', () => {
  const ALL_17_PERMISSIONS: readonly Permission[] = Object.freeze([
    'workspace:create',
    'workspace:read',
    'workspace:update',
    'workspace:delete',
    'member:read',
    'member:manage',
    'document:read',
    'document:upload',
    'document:delete',
    'thread:read',
    'thread:create',
    'run:execute',
    'run:cancel',
    'memory:read',
    'memory:write_self',
    'memory:write_shared',
    'audit:read',
  ]);

  const validWorkspaceIdA = 'a0000000-0000-0000-0000-000000000001';
  const validWorkspaceIdB = 'b0000000-0000-0000-0000-000000000002';
  const sampleUserId = 'u0000000-0000-0000-0000-000000000001';
  const sampleOrgId = 'o0000000-0000-0000-0000-000000000001';

  function createMockExecutionContext(
    req: Partial<Request>,
    handler?: (...args: unknown[]) => unknown,
    controllerClass?: new (...args: unknown[]) => unknown,
  ): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => req as Request,
        getResponse: () => ({}),
        getNext: () => ({}),
      }),
      getHandler: () => handler ?? (() => {}),
      getClass: () => controllerClass ?? (class DummyController {}),
      getArgs: () => [],
      getArgByIndex: () => ({}),
      switchToRpc: () => ({}) as never,
      switchToWs: () => ({}) as never,
      getType: () => 'http',
    } as unknown as ExecutionContext;
  }

  function setupAuthenticatedRequest(
    userId = sampleUserId,
    orgId = sampleOrgId,
    email = 'test@example.com',
  ): Request {
    const req = {
      headers: {},
      params: {},
      query: {},
      body: {},
    } as unknown as Request;

    const ctx = createRequestContext({
      principal: { userId, organizationId: orgId, email },
      metadata: { correlationId: 'test-corr-123', receivedAt: new Date() },
    });

    bindRequestContext(req, ctx);
    return req;
  }

  // =========================================================================
  // 1. CANONICAL ROLES & PERMISSIONS MODEL (Discrete Capability Matrix)
  // =========================================================================
  describe('Canonical Roles & Permission Capability Matrix', () => {
    it('should declare exactly 4 canonical roles and 17 atomic permissions', () => {
      expect(WORKSPACE_ROLES).toEqual(['viewer', 'contributor', 'workspace_admin', 'org_admin']);
      expect(ALL_17_PERMISSIONS.length).toBe(17);
    });

    it('should map viewer role to exact discrete capabilities', () => {
      const viewerPerms = ROLE_PERMISSIONS_MAP.viewer;
      expect(Object.keys(viewerPerms).sort()).toEqual([
        'document:read',
        'memory:read',
        'member:read',
        'thread:read',
        'workspace:read',
      ].sort());

      expect(hasPermission(viewerPerms, 'workspace:read')).toBe(true);
      expect(hasPermission(viewerPerms, 'member:read')).toBe(true);
      expect(hasPermission(viewerPerms, 'document:read')).toBe(true);
      expect(hasPermission(viewerPerms, 'thread:read')).toBe(true);
      expect(hasPermission(viewerPerms, 'memory:read')).toBe(true);

      // Denied capabilities
      expect(hasPermission(viewerPerms, 'document:upload')).toBe(false);
      expect(hasPermission(viewerPerms, 'document:delete')).toBe(false);
      expect(hasPermission(viewerPerms, 'workspace:create')).toBe(false);
      expect(hasPermission(viewerPerms, 'workspace:update')).toBe(false);
      expect(hasPermission(viewerPerms, 'workspace:delete')).toBe(false);
      expect(hasPermission(viewerPerms, 'member:manage')).toBe(false);
      expect(hasPermission(viewerPerms, 'run:execute')).toBe(false);
      expect(hasPermission(viewerPerms, 'run:cancel')).toBe(false);
      expect(hasPermission(viewerPerms, 'memory:write_self')).toBe(false);
      expect(hasPermission(viewerPerms, 'memory:write_shared')).toBe(false);
      expect(hasPermission(viewerPerms, 'audit:read')).toBe(false);
    });

    it('should map contributor role to exact discrete capabilities', () => {
      const contributorPerms = ROLE_PERMISSIONS_MAP.contributor;
      expect(Object.keys(contributorPerms).sort()).toEqual([
        'document:read',
        'document:upload',
        'member:read',
        'memory:read',
        'memory:write_self',
        'run:cancel',
        'run:execute',
        'thread:create',
        'thread:read',
        'workspace:read',
      ].sort());

      expect(hasPermission(contributorPerms, 'document:upload')).toBe(true);
      expect(hasPermission(contributorPerms, 'thread:create')).toBe(true);
      expect(hasPermission(contributorPerms, 'run:execute')).toBe(true);
      expect(hasPermission(contributorPerms, 'run:cancel')).toBe(true);
      expect(hasPermission(contributorPerms, 'memory:write_self')).toBe(true);

      // Denied capabilities
      expect(hasPermission(contributorPerms, 'workspace:update')).toBe(false);
      expect(hasPermission(contributorPerms, 'workspace:delete')).toBe(false);
      expect(hasPermission(contributorPerms, 'workspace:create')).toBe(false);
      expect(hasPermission(contributorPerms, 'member:manage')).toBe(false);
      expect(hasPermission(contributorPerms, 'document:delete')).toBe(false);
      expect(hasPermission(contributorPerms, 'memory:write_shared')).toBe(false);
      expect(hasPermission(contributorPerms, 'audit:read')).toBe(false);
    });

    it('should map workspace_admin role to exact discrete capabilities (15 permissions, excluding workspace:create and workspace:delete)', () => {
      const adminPerms = ROLE_PERMISSIONS_MAP.workspace_admin;
      expect(Object.keys(adminPerms).length).toBe(15);

      // workspace_admin cannot create or delete workspaces (org-level capabilities)
      expect(hasPermission(adminPerms, 'workspace:create')).toBe(false);
      expect(hasPermission(adminPerms, 'workspace:delete')).toBe(false);

      // All other 15 permissions are allowed
      const allowedPerms = ALL_17_PERMISSIONS.filter(
        (p) => p !== 'workspace:create' && p !== 'workspace:delete',
      );
      for (const perm of allowedPerms) {
        expect(hasPermission(adminPerms, perm)).toBe(true);
      }
    });

    it('should map org_admin role to all 17 atomic capabilities', () => {
      const orgAdminPerms = ROLE_PERMISSIONS_MAP.org_admin;
      expect(Object.keys(orgAdminPerms).length).toBe(17);
      for (const perm of ALL_17_PERMISSIONS) {
        expect(hasPermission(orgAdminPerms, perm)).toBe(true);
      }
    });

    it('should enforce non-ordinal capabilities (no numeric comparison or implicit elevation)', () => {
      // workspace_admin is "higher" than contributor in business terms, but capability check is discrete
      expect(hasPermission(ROLE_PERMISSIONS_MAP.workspace_admin, 'workspace:create')).toBe(false);
      expect(hasPermission(ROLE_PERMISSIONS_MAP.org_admin, 'workspace:create')).toBe(true);
    });

    it('should return false for undefined or null permission maps', () => {
      expect(hasPermission(undefined, 'workspace:read')).toBe(false);
    });
  });

  // =========================================================================
  // 2. @RequirePermissions DECORATOR
  // =========================================================================
  describe('@RequirePermissions Decorator', () => {
    it('should attach permission metadata to method handlers', () => {
      class TestController {
        @RequirePermissions('document:read', 'document:upload')
        testHandler() {}
      }

      const reflector = new Reflector();
      const metadata = reflector.get<Permission[]>(PERMISSIONS_KEY, TestController.prototype.testHandler);
      expect(metadata).toEqual(['document:read', 'document:upload']);
    });

    it('should attach permission metadata to controller classes', () => {
      @RequirePermissions('workspace:read')
      class TestController {}

      const reflector = new Reflector();
      const metadata = reflector.get<Permission[]>(PERMISSIONS_KEY, TestController);
      expect(metadata).toEqual(['workspace:read']);
    });
  });

  // =========================================================================
  // 3. PermissionsGuard
  // =========================================================================
  describe('PermissionsGuard', () => {
    let reflector: Reflector;
    let guard: PermissionsGuard;

    beforeEach(() => {
      reflector = new Reflector();
      guard = new PermissionsGuard(reflector);
    });

    it('should allow route execution when no @RequirePermissions metadata is declared', () => {
      const req = setupAuthenticatedRequest();
      const context = createMockExecutionContext(req);

      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

      expect(guard.canActivate(context)).toBe(true);
    });

    it('should fail closed with 401 Unauthorized if request context is unauthenticated', () => {
      const unauthReq = {} as unknown as Request;
      const context = createMockExecutionContext(unauthReq);

      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['workspace:read']);

      expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    });

    it('should fail closed with 403 Forbidden if user is authenticated but has no active tenantScope', () => {
      const req = setupAuthenticatedRequest(); // has principal, but tenantScope is undefined
      const context = createMockExecutionContext(req);

      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['workspace:read']);

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should allow when caller has the exact single required capability', () => {
      const req = setupAuthenticatedRequest();
      const enriched = createRequestContext({
        principal: getRequestContext(req)!.principal,
        tenantScope: {
          workspaceId: validWorkspaceIdA,
          organizationId: sampleOrgId,
          role: 'viewer',
          permissions: ROLE_PERMISSIONS_MAP.viewer,
        },
        metadata: getRequestContext(req)!.metadata,
      });
      bindRequestContext(req, enriched);

      const context = createMockExecutionContext(req);
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['document:read']);

      expect(guard.canActivate(context)).toBe(true);
    });

    it('should deny with 403 Forbidden when caller lacks the single required capability', () => {
      const req = setupAuthenticatedRequest();
      const enriched = createRequestContext({
        principal: getRequestContext(req)!.principal,
        tenantScope: {
          workspaceId: validWorkspaceIdA,
          organizationId: sampleOrgId,
          role: 'viewer',
          permissions: ROLE_PERMISSIONS_MAP.viewer,
        },
        metadata: getRequestContext(req)!.metadata,
      });
      bindRequestContext(req, enriched);

      const context = createMockExecutionContext(req);
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['document:upload']); // viewer cannot upload

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow(/Missing required capability \[document:upload\]/);
    });

    it('should require ALL permissions when multiple are specified (AND logic)', () => {
      const req = setupAuthenticatedRequest();
      const enriched = createRequestContext({
        principal: getRequestContext(req)!.principal,
        tenantScope: {
          workspaceId: validWorkspaceIdA,
          organizationId: sampleOrgId,
          role: 'contributor',
          permissions: ROLE_PERMISSIONS_MAP.contributor,
        },
        metadata: getRequestContext(req)!.metadata,
      });
      bindRequestContext(req, enriched);

      const context = createMockExecutionContext(req);

      // Contributor has both document:read and document:upload
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['document:read', 'document:upload']);
      expect(guard.canActivate(context)).toBe(true);

      // Contributor has document:read but NOT document:delete -> must deny
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['document:read', 'document:delete']);
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow(/Missing required capability \[document:delete\]/);
    });

    it('should fail closed with 403 Forbidden on malformed permission metadata', () => {
      const req = setupAuthenticatedRequest();
      const enriched = createRequestContext({
        principal: getRequestContext(req)!.principal,
        tenantScope: {
          workspaceId: validWorkspaceIdA,
          organizationId: sampleOrgId,
          role: 'workspace_admin',
          permissions: ROLE_PERMISSIONS_MAP.workspace_admin,
        },
        metadata: getRequestContext(req)!.metadata,
      });
      bindRequestContext(req, enriched);

      const context = createMockExecutionContext(req);

      // Malformed metadata: not an array
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue('workspace:read' as unknown as Permission[]);
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow(/Malformed authorization metadata/);
    });
  });

  // =========================================================================
  // 4. WorkspaceMemberGuard
  // =========================================================================
  describe('WorkspaceMemberGuard', () => {
    let mockMembershipProvider: jest.Mocked<WorkspaceMembershipProvider>;
    let guard: WorkspaceMemberGuard;

    beforeEach(() => {
      mockMembershipProvider = {
        findMembership: jest.fn(),
      };
      guard = new WorkspaceMemberGuard(mockMembershipProvider);
    });

    it('should fail closed with 401 Unauthorized if request is unauthenticated', async () => {
      const unauthReq = { params: { workspace_id: validWorkspaceIdA } } as unknown as Request;
      const context = createMockExecutionContext(unauthReq);

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('should fail closed with 403 Forbidden if workspace ID parameter is missing from route', async () => {
      const req = setupAuthenticatedRequest();
      (req as unknown as { params: Record<string, string> }).params = {};
      const context = createMockExecutionContext(req);

      await expect(guard.canActivate(context)).rejects.toThrow(/Missing or invalid workspace identifier/);
    });

    it('should fail closed with 403 Forbidden if workspace ID parameter is not a valid UUID', async () => {
      const req = setupAuthenticatedRequest();
      (req as unknown as { params: Record<string, string> }).params = { workspace_id: 'not-a-valid-uuid' };
      const context = createMockExecutionContext(req);

      await expect(guard.canActivate(context)).rejects.toThrow(/Missing or invalid workspace identifier/);
    });

    it('should allow and enrich RequestContext when user is a valid workspace member', async () => {
      const req = setupAuthenticatedRequest();
      (req as unknown as { params: Record<string, string> }).params = { workspace_id: validWorkspaceIdA };
      const context = createMockExecutionContext(req);

      mockMembershipProvider.findMembership.mockResolvedValueOnce({
        workspaceId: validWorkspaceIdA,
        userId: sampleUserId,
        role: 'contributor',
      });

      const allowed = await guard.canActivate(context);
      expect(allowed).toBe(true);

      const enrichedCtx = getRequestContext(req);
      expect(enrichedCtx).toBeDefined();
      expect(enrichedCtx?.tenantScope).toBeDefined();
      expect(enrichedCtx?.tenantScope?.workspaceId).toBe(validWorkspaceIdA);
      expect(enrichedCtx?.tenantScope?.role).toBe('contributor');
      expect(enrichedCtx?.tenantScope?.permissions).toEqual(ROLE_PERMISSIONS_MAP.contributor);
      expect(Object.isFrozen(enrichedCtx?.tenantScope)).toBe(true);
      expect(Object.isFrozen(enrichedCtx?.tenantScope?.permissions)).toBe(true);
    });

    it('should support canonical route parameter names (:workspace_id, :workspaceId) and reject generic :id', async () => {
      const req1 = setupAuthenticatedRequest();
      (req1 as unknown as { params: Record<string, string> }).params = { workspaceId: validWorkspaceIdA };
      mockMembershipProvider.findMembership.mockResolvedValueOnce({
        workspaceId: validWorkspaceIdA,
        userId: sampleUserId,
        role: 'viewer',
      });
      expect(await guard.canActivate(createMockExecutionContext(req1))).toBe(true);

      // Generic :id is not an authorized workspace parameter and must fail closed
      const req2 = setupAuthenticatedRequest();
      (req2 as unknown as { params: Record<string, string> }).params = { id: validWorkspaceIdA };
      await expect(guard.canActivate(createMockExecutionContext(req2))).rejects.toThrow(
        /Missing or invalid workspace identifier/,
      );
    });

    it('should fail closed with 404 Not Found when user is not a member of the workspace (anti-enumeration)', async () => {
      const req = setupAuthenticatedRequest();
      (req as unknown as { params: Record<string, string> }).params = { workspace_id: validWorkspaceIdA };
      const context = createMockExecutionContext(req);

      mockMembershipProvider.findMembership.mockResolvedValueOnce(null);

      await expect(guard.canActivate(context)).rejects.toThrow(NotFoundException);
      await expect(guard.canActivate(context)).rejects.toThrow(/Workspace not found/);
    });

    it('should prevent IDOR: user belonging to Workspace A attempting to access Workspace B is rejected with 404', async () => {
      const req = setupAuthenticatedRequest();
      // Caller requests Workspace B
      (req as unknown as { params: Record<string, string> }).params = { workspace_id: validWorkspaceIdB };
      const context = createMockExecutionContext(req);

      // Database returns null because user is only in Workspace A
      mockMembershipProvider.findMembership.mockResolvedValueOnce(null);

      await expect(guard.canActivate(context)).rejects.toThrow(NotFoundException);
      expect(mockMembershipProvider.findMembership).toHaveBeenCalledWith(validWorkspaceIdB, sampleUserId);
    });

    it('should fail closed with 403 Forbidden if database returns an unknown/invalid role', async () => {
      const req = setupAuthenticatedRequest();
      (req as unknown as { params: Record<string, string> }).params = { workspace_id: validWorkspaceIdA };
      const context = createMockExecutionContext(req);

      mockMembershipProvider.findMembership.mockResolvedValueOnce({
        workspaceId: validWorkspaceIdA,
        userId: sampleUserId,
        role: 'super_admin' as unknown as WorkspaceRole, // Invalid role not in WORKSPACE_ROLES
      });

      await expect(guard.canActivate(context)).rejects.toThrow(/Invalid or unrecognized workspace role/);
    });

    it('should reject conflicting existing tenantScope with 403 Forbidden', async () => {
      const req = {
        headers: {},
        params: { workspace_id: validWorkspaceIdA },
        query: {},
        body: {},
      } as unknown as Request;

      // Bind an existing tenantScope for a DIFFERENT workspace
      const preEnriched = createRequestContext({
        principal: { userId: sampleUserId, organizationId: sampleOrgId, email: 'test@example.com' },
        tenantScope: {
          workspaceId: validWorkspaceIdB,
          organizationId: sampleOrgId,
          role: 'org_admin',
          permissions: ROLE_PERMISSIONS_MAP.org_admin,
        },
        metadata: { correlationId: 'test-corr-123', receivedAt: new Date() },
      });
      bindRequestContext(req, preEnriched);

      mockMembershipProvider.findMembership.mockResolvedValue({
        workspaceId: validWorkspaceIdA,
        userId: sampleUserId,
        role: 'contributor',
      });

      const context = createMockExecutionContext(req);
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      await expect(guard.canActivate(context)).rejects.toThrow(/Conflicting tenant context/);
    });

    it('should idempotently allow if tenantScope already matches requested workspace and role', async () => {
      const req = {
        headers: {},
        params: { workspace_id: validWorkspaceIdA },
        query: {},
        body: {},
      } as unknown as Request;

      const matchingEnriched = createRequestContext({
        principal: { userId: sampleUserId, organizationId: sampleOrgId, email: 'test@example.com' },
        tenantScope: {
          workspaceId: validWorkspaceIdA,
          organizationId: sampleOrgId,
          role: 'viewer',
          permissions: ROLE_PERMISSIONS_MAP.viewer,
        },
        metadata: { correlationId: 'test-corr-123', receivedAt: new Date() },
      });
      bindRequestContext(req, matchingEnriched);

      mockMembershipProvider.findMembership.mockResolvedValue({
        workspaceId: validWorkspaceIdA,
        userId: sampleUserId,
        role: 'viewer',
      });

      const context = createMockExecutionContext(req);
      const allowed = await guard.canActivate(context);
      expect(allowed).toBe(true);
    });

    it('should NOT trust client-supplied role in body, query, params, or headers', async () => {
      const req = setupAuthenticatedRequest();
      const rawReq = req as unknown as {
        params: Record<string, string>;
        body: Record<string, string>;
        query: Record<string, string>;
        headers: Record<string, string>;
      };
      rawReq.params = { workspace_id: validWorkspaceIdA, role: 'org_admin' };
      rawReq.body = { role: 'org_admin' };
      rawReq.query = { role: 'org_admin' };
      rawReq.headers = { 'x-role': 'org_admin', 'x-permission': 'workspace:delete' };

      const context = createMockExecutionContext(req);

      // Database returns viewer
      mockMembershipProvider.findMembership.mockResolvedValueOnce({
        workspaceId: validWorkspaceIdA,
        userId: sampleUserId,
        role: 'viewer',
      });

      await guard.canActivate(context);

      // Role is viewer as authoritative from DB, NOT org_admin from client input
      const enriched = getRequestContext(req);
      expect(enriched?.tenantScope?.role).toBe('viewer');
      expect(enriched?.tenantScope?.permissions).toEqual(ROLE_PERMISSIONS_MAP.viewer);
      expect(hasPermission(enriched?.tenantScope?.permissions, 'workspace:delete')).toBe(false);
    });
  });

  // =========================================================================
  // 5. WorkspaceBootstrapGuard
  // =========================================================================
  describe('WorkspaceBootstrapGuard', () => {
    let mockBootstrapProvider: jest.Mocked<WorkspaceBootstrapProvider>;
    let bootstrapGuard: WorkspaceBootstrapGuard;

    beforeEach(() => {
      mockBootstrapProvider = {
        getUserMemberships: jest.fn(),
      };
      bootstrapGuard = new WorkspaceBootstrapGuard(mockBootstrapProvider);
    });

    it('should fail closed with 401 Unauthorized if request is unauthenticated', async () => {
      const unauthReq = {} as unknown as Request;
      const context = createMockExecutionContext(unauthReq);

      await expect(bootstrapGuard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('should allow active authenticated user with zero visible workspaces (Case A: first workspace bootstrap)', async () => {
      const req = setupAuthenticatedRequest();
      const context = createMockExecutionContext(req);

      mockBootstrapProvider.getUserMemberships.mockResolvedValueOnce([]);

      const allowed = await bootstrapGuard.canActivate(context);
      expect(allowed).toBe(true);
      expect(mockBootstrapProvider.getUserMemberships).toHaveBeenCalledWith(sampleUserId);
    });

    it('should allow user with existing workspaces when user is org_admin (Case B: subsequent workspace)', async () => {
      const req = setupAuthenticatedRequest();
      const context = createMockExecutionContext(req);

      mockBootstrapProvider.getUserMemberships.mockResolvedValueOnce([
        { workspaceId: validWorkspaceIdA, role: 'org_admin' },
      ]);

      const allowed = await bootstrapGuard.canActivate(context);
      expect(allowed).toBe(true);
      expect(mockBootstrapProvider.getUserMemberships).toHaveBeenCalledWith(sampleUserId);
    });

    it('should deny with 403 Forbidden when user has existing workspaces but lacks org_admin role (Case B: non-admin)', async () => {
      const req = setupAuthenticatedRequest();
      const context = createMockExecutionContext(req);

      // User has existing membership but only as workspace_admin, contributor, viewer
      mockBootstrapProvider.getUserMemberships.mockResolvedValue([
        { workspaceId: validWorkspaceIdA, role: 'workspace_admin' },
        { workspaceId: validWorkspaceIdB, role: 'viewer' },
      ]);

      await expect(bootstrapGuard.canActivate(context)).rejects.toThrow(ForbiddenException);
      await expect(bootstrapGuard.canActivate(context)).rejects.toThrow(
        /Only organization administrators can create additional workspaces/,
      );
    });

    it('should NOT perform DB writes and remain strictly an advisory pre-flight guard', async () => {
      const req = setupAuthenticatedRequest();
      const context = createMockExecutionContext(req);

      mockBootstrapProvider.getUserMemberships.mockResolvedValueOnce([]);

      const allowed = await bootstrapGuard.canActivate(context);
      expect(allowed).toBe(true);

      // Provider only has read queries, no write methods exist or were invoked
      expect(mockBootstrapProvider.getUserMemberships).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // 5. GUARD PIPELINE INTEGRATION & END-TO-END RBAC FLOW
  // =========================================================================
  describe('Guard Pipeline Integration (WorkspaceMemberGuard -> PermissionsGuard)', () => {
    let reflector: Reflector;
    let permissionsGuard: PermissionsGuard;
    let mockMembershipProvider: jest.Mocked<WorkspaceMembershipProvider>;
    let memberGuard: WorkspaceMemberGuard;

    beforeEach(() => {
      reflector = new Reflector();
      permissionsGuard = new PermissionsGuard(reflector);
      mockMembershipProvider = {
        findMembership: jest.fn(),
      };
      memberGuard = new WorkspaceMemberGuard(mockMembershipProvider);
    });

    it('should allow full pipeline when caller is member and has required capability', async () => {
      const req = setupAuthenticatedRequest();
      (req as unknown as { params: Record<string, string> }).params = { workspace_id: validWorkspaceIdA };
      const context = createMockExecutionContext(req);

      // Member is workspace_admin
      mockMembershipProvider.findMembership.mockResolvedValueOnce({
        workspaceId: validWorkspaceIdA,
        userId: sampleUserId,
        role: 'workspace_admin',
      });

      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['document:delete']);

      // 1. WorkspaceMemberGuard runs
      const memberGuardResult = await memberGuard.canActivate(context);
      expect(memberGuardResult).toBe(true);

      // 2. PermissionsGuard runs on enriched context
      const permissionsGuardResult = permissionsGuard.canActivate(context);
      expect(permissionsGuardResult).toBe(true);
    });

    it('should reject at PermissionsGuard when member role lacks capability (contributor attempting document:delete)', async () => {
      const req = setupAuthenticatedRequest();
      (req as unknown as { params: Record<string, string> }).params = { workspace_id: validWorkspaceIdA };
      const context = createMockExecutionContext(req);

      // Member is contributor
      mockMembershipProvider.findMembership.mockResolvedValueOnce({
        workspaceId: validWorkspaceIdA,
        userId: sampleUserId,
        role: 'contributor',
      });

      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['document:delete']);

      // 1. WorkspaceMemberGuard succeeds and sets contributor tenantScope
      const memberGuardResult = await memberGuard.canActivate(context);
      expect(memberGuardResult).toBe(true);

      // 2. PermissionsGuard rejects because contributor cannot delete documents
      expect(() => permissionsGuard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  // =========================================================================
  // 6. REQUEST ISOLATION & CONCURRENCY INTEGRITY
  // =========================================================================
  describe('Request Isolation & Concurrency Integrity', () => {
    it('should maintain strict request isolation between concurrent requests', async () => {
      const mockMembershipProvider: jest.Mocked<WorkspaceMembershipProvider> = {
        findMembership: jest.fn(),
      };
      const memberGuard = new WorkspaceMemberGuard(mockMembershipProvider);
      const reflector = new Reflector();
      const permissionsGuard = new PermissionsGuard(reflector);

      // Request 1: User 1 (viewer in Workspace A)
      const req1 = setupAuthenticatedRequest('user-1', 'org-1', 'user1@example.com');
      (req1 as unknown as { params: Record<string, string> }).params = { workspace_id: validWorkspaceIdA };

      // Request 2: User 2 (workspace_admin in Workspace B)
      const req2 = setupAuthenticatedRequest('user-2', 'org-2', 'user2@example.com');
      (req2 as unknown as { params: Record<string, string> }).params = { workspace_id: validWorkspaceIdB };

      mockMembershipProvider.findMembership.mockImplementation(async (wsId, uId) => {
        if (wsId === validWorkspaceIdA && uId === 'user-1') {
          return { workspaceId: validWorkspaceIdA, userId: 'user-1', role: 'viewer' };
        }
        if (wsId === validWorkspaceIdB && uId === 'user-2') {
          return { workspaceId: validWorkspaceIdB, userId: 'user-2', role: 'workspace_admin' };
        }
        return null;
      });

      const context1 = createMockExecutionContext(req1);
      const context2 = createMockExecutionContext(req2);

      await memberGuard.canActivate(context1);
      await memberGuard.canActivate(context2);

      const ctx1 = getRequestContext(req1);
      const ctx2 = getRequestContext(req2);

      // Verify req1 context
      expect(ctx1?.principal.userId).toBe('user-1');
      expect(ctx1?.tenantScope?.workspaceId).toBe(validWorkspaceIdA);
      expect(ctx1?.tenantScope?.role).toBe('viewer');

      // Verify req2 context
      expect(ctx2?.principal.userId).toBe('user-2');
      expect(ctx2?.tenantScope?.workspaceId).toBe(validWorkspaceIdB);
      expect(ctx2?.tenantScope?.role).toBe('workspace_admin');

      // Verify permission checks are isolated
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['document:delete']);

      // req1 (viewer) cannot delete
      expect(() => permissionsGuard.canActivate(context1)).toThrow(ForbiddenException);

      // req2 (admin) can delete
      expect(permissionsGuard.canActivate(context2)).toBe(true);
    });
  });

  // =========================================================================
  // 7. REQUEST CONTEXT IMMUTABILITY & LIFECYCLE INTEGRITY
  // =========================================================================
  describe('RequestContext Immutability & Lifecycle Protection', () => {
    it('should ensure original initial RequestContext is NEVER mutated during tenantScope enrichment', () => {
      const initialCtx = createRequestContext({
        principal: { userId: sampleUserId, organizationId: sampleOrgId, email: 'test@example.com' },
        metadata: { correlationId: 'corr-001', receivedAt: new Date() },
      });

      const mockReq = {} as unknown as Request;
      bindRequestContext(mockReq, initialCtx);

      // Verify initial context has no tenantScope
      expect(initialCtx.tenantScope).toBeUndefined();
      expect(Object.isFrozen(initialCtx)).toBe(true);

      // Construct a new enriched context instance
      const enrichedCtx = createRequestContext({
        principal: initialCtx.principal,
        tenantScope: {
          workspaceId: validWorkspaceIdA,
          organizationId: sampleOrgId,
          role: 'contributor',
          permissions: ROLE_PERMISSIONS_MAP.contributor,
        },
        metadata: initialCtx.metadata,
      });

      // Bind the enriched context
      bindRequestContext(mockReq, enrichedCtx);

      // Verify: Initial context instance was NOT mutated and still has tenantScope === undefined
      expect(initialCtx.tenantScope).toBeUndefined();
      expect(Object.isFrozen(initialCtx)).toBe(true);

      // Verify: Enriched context is a completely separate instance and deeply frozen
      const retrieved = getRequestContext(mockReq);
      expect(retrieved).toBe(enrichedCtx);
      expect(retrieved).not.toBe(initialCtx);
      expect(Object.isFrozen(retrieved)).toBe(true);
      expect(Object.isFrozen(retrieved?.tenantScope)).toBe(true);
      expect(Object.isFrozen(retrieved?.tenantScope?.permissions)).toBe(true);
    });

    it('should fail closed if enrichment attempts to alter principal userId or organizationId', () => {
      const initialCtx = createRequestContext({
        principal: { userId: sampleUserId, organizationId: sampleOrgId, email: 'test@example.com' },
        metadata: { correlationId: 'corr-001', receivedAt: new Date() },
      });

      const mockReq = {} as unknown as Request;
      bindRequestContext(mockReq, initialCtx);

      // Malicious attempt: try to change userId during enrichment
      const maliciousCtx = createRequestContext({
        principal: { userId: 'tampered-user-id', organizationId: sampleOrgId, email: 'test@example.com' },
        tenantScope: {
          workspaceId: validWorkspaceIdA,
          organizationId: sampleOrgId,
          role: 'org_admin',
          permissions: ROLE_PERMISSIONS_MAP.org_admin,
        },
        metadata: initialCtx.metadata,
      });

      expect(() => bindRequestContext(mockReq, maliciousCtx)).toThrow(
        /Cannot overwrite existing RequestContext on request/,
      );

      // Context remains original
      expect(getRequestContext(mockReq)?.principal.userId).toBe(sampleUserId);
    });

    it('should fail closed if attempting to overwrite an already enriched tenantScope', () => {
      const initialCtx = createRequestContext({
        principal: { userId: sampleUserId, organizationId: sampleOrgId, email: 'test@example.com' },
        metadata: { correlationId: 'corr-001', receivedAt: new Date() },
      });

      const mockReq = {} as unknown as Request;
      bindRequestContext(mockReq, initialCtx);

      const enrichedCtx1 = createRequestContext({
        principal: initialCtx.principal,
        tenantScope: {
          workspaceId: validWorkspaceIdA,
          organizationId: sampleOrgId,
          role: 'viewer',
          permissions: ROLE_PERMISSIONS_MAP.viewer,
        },
        metadata: initialCtx.metadata,
      });

      bindRequestContext(mockReq, enrichedCtx1);

      // Second attempt to overwrite existing tenantScope with a different workspace/role
      const enrichedCtx2 = createRequestContext({
        principal: initialCtx.principal,
        tenantScope: {
          workspaceId: validWorkspaceIdB,
          organizationId: sampleOrgId,
          role: 'org_admin',
          permissions: ROLE_PERMISSIONS_MAP.org_admin,
        },
        metadata: initialCtx.metadata,
      });

      expect(() => bindRequestContext(mockReq, enrichedCtx2)).toThrow(
        /Cannot overwrite existing RequestContext on request/,
      );

      // Original enriched context remains intact
      expect(getRequestContext(mockReq)?.tenantScope?.workspaceId).toBe(validWorkspaceIdA);
      expect(getRequestContext(mockReq)?.tenantScope?.role).toBe('viewer');
    });

    it('should reject runtime mutation on enriched RequestContext and TenantScope in strict mode', () => {
      const enrichedCtx = createRequestContext({
        principal: { userId: sampleUserId, organizationId: sampleOrgId, email: 'test@example.com' },
        tenantScope: {
          workspaceId: validWorkspaceIdA,
          organizationId: sampleOrgId,
          role: 'viewer',
          permissions: ROLE_PERMISSIONS_MAP.viewer,
        },
        metadata: { correlationId: 'corr-001', receivedAt: new Date() },
      });

      expect(() => {
        // @ts-expect-error - Testing runtime mutation rejection
        enrichedCtx.tenantScope = undefined;
      }).toThrow(TypeError);

      expect(() => {
        // @ts-expect-error - Testing runtime mutation rejection
        enrichedCtx.tenantScope!.role = 'org_admin';
      }).toThrow(TypeError);

      expect(() => {
        // @ts-expect-error - Testing runtime mutation rejection
        enrichedCtx.tenantScope!.permissions['workspace:delete'] = true;
      }).toThrow(TypeError);
    });
  });

  // =========================================================================
  // 8. DECLARATIVE ROUTE & CONTROLLER GUARD PIPELINE SIMULATION
  // =========================================================================
  describe('Declarative Controller Route Guard Composition (@UseGuards)', () => {
    // Simulating an actual NestJS Controller:
    // @Controller('v1/workspaces/:workspace_id/documents')
    // @UseGuards(WorkspaceMemberGuard, PermissionsGuard)
    class TestDocumentsController {
      @RequirePermissions('document:read')
      listDocuments() {
        return { message: 'documents list' };
      }

      @RequirePermissions('document:upload')
      uploadDocument() {
        return { message: 'document uploaded' };
      }

      @RequirePermissions('document:delete')
      deleteDocument() {
        return { message: 'document deleted' };
      }

      // Route without @RequirePermissions (membership-only access)
      getOverview() {
        return { message: 'workspace overview' };
      }
    }

    let controller: TestDocumentsController;
    let reflector: Reflector;
    let permissionsGuard: PermissionsGuard;
    let mockMembershipProvider: jest.Mocked<WorkspaceMembershipProvider>;
    let memberGuard: WorkspaceMemberGuard;

    beforeEach(() => {
      controller = new TestDocumentsController();
      reflector = new Reflector();
      permissionsGuard = new PermissionsGuard(reflector);
      mockMembershipProvider = {
        findMembership: jest.fn(),
      };
      memberGuard = new WorkspaceMemberGuard(mockMembershipProvider);
    });

    async function executeGuardPipeline(
      req: Request,
      handler: (...args: unknown[]) => unknown,
    ): Promise<boolean> {
      const context = createMockExecutionContext(req, handler, TestDocumentsController);

      // Layer 2: WorkspaceMemberGuard
      const memberAllowed = await memberGuard.canActivate(context);
      if (!memberAllowed) {
        return false;
      }

      // Layer 3: PermissionsGuard
      return permissionsGuard.canActivate(context);
    }

    it('should reject unauthenticated request with 401 at member guard', async () => {
      const unauthReq = { params: { workspace_id: validWorkspaceIdA } } as unknown as Request;

      await expect(
        executeGuardPipeline(unauthReq, controller.listDocuments),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should reject non-member with 404 at WorkspaceMemberGuard (PermissionsGuard never reached)', async () => {
      const req = setupAuthenticatedRequest();
      (req as unknown as { params: Record<string, string> }).params = { workspace_id: validWorkspaceIdA };

      mockMembershipProvider.findMembership.mockResolvedValueOnce(null);

      await expect(
        executeGuardPipeline(req, controller.listDocuments),
      ).rejects.toThrow(NotFoundException);
    });

    it('should allow viewer on document:read but reject on document:upload and document:delete', async () => {
      const req = setupAuthenticatedRequest();
      (req as unknown as { params: Record<string, string> }).params = { workspace_id: validWorkspaceIdA };

      mockMembershipProvider.findMembership.mockResolvedValue({
        workspaceId: validWorkspaceIdA,
        userId: sampleUserId,
        role: 'viewer',
      });

      // 1. viewer -> listDocuments (@RequirePermissions('document:read')) -> ALLOWED
      const allowedRead = await executeGuardPipeline(req, controller.listDocuments);
      expect(allowedRead).toBe(true);

      // 2. viewer -> uploadDocument (@RequirePermissions('document:upload')) -> 403 FORBIDDEN
      await expect(
        executeGuardPipeline(req, controller.uploadDocument),
      ).rejects.toThrow(/Missing required capability \[document:upload\]/);

      // 3. viewer -> deleteDocument (@RequirePermissions('document:delete')) -> 403 FORBIDDEN
      await expect(
        executeGuardPipeline(req, controller.deleteDocument),
      ).rejects.toThrow(/Missing required capability \[document:delete\]/);
    });

    it('should allow contributor on document:read and document:upload but reject on document:delete', async () => {
      const req = setupAuthenticatedRequest();
      (req as unknown as { params: Record<string, string> }).params = { workspace_id: validWorkspaceIdA };

      mockMembershipProvider.findMembership.mockResolvedValue({
        workspaceId: validWorkspaceIdA,
        userId: sampleUserId,
        role: 'contributor',
      });

      // contributor -> listDocuments -> ALLOWED
      expect(await executeGuardPipeline(req, controller.listDocuments)).toBe(true);

      // contributor -> uploadDocument -> ALLOWED
      expect(await executeGuardPipeline(req, controller.uploadDocument)).toBe(true);

      // contributor -> deleteDocument -> 403 FORBIDDEN
      await expect(
        executeGuardPipeline(req, controller.deleteDocument),
      ).rejects.toThrow(/Missing required capability \[document:delete\]/);
    });

    it('should allow workspace_admin on all document operations (read, upload, delete)', async () => {
      const req = setupAuthenticatedRequest();
      (req as unknown as { params: Record<string, string> }).params = { workspace_id: validWorkspaceIdA };

      mockMembershipProvider.findMembership.mockResolvedValue({
        workspaceId: validWorkspaceIdA,
        userId: sampleUserId,
        role: 'workspace_admin',
      });

      expect(await executeGuardPipeline(req, controller.listDocuments)).toBe(true);
      expect(await executeGuardPipeline(req, controller.uploadDocument)).toBe(true);
      expect(await executeGuardPipeline(req, controller.deleteDocument)).toBe(true);
    });

    it('should allow member on route without @RequirePermissions (membership-only access)', async () => {
      const req = setupAuthenticatedRequest();
      (req as unknown as { params: Record<string, string> }).params = { workspace_id: validWorkspaceIdA };

      mockMembershipProvider.findMembership.mockResolvedValue({
        workspaceId: validWorkspaceIdA,
        userId: sampleUserId,
        role: 'viewer',
      });

      // getOverview has no @RequirePermissions -> allowed for any authenticated workspace member
      expect(await executeGuardPipeline(req, controller.getOverview)).toBe(true);
    });
  });
});


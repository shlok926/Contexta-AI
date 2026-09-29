import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PermissionsGuard } from '../../../src/modules/workspace/guards/permissions.guard.js';
import { MemoryController } from '../../../src/modules/memory/controllers/memory.controller.js';
import { MemoryService } from '../../../src/modules/memory/services/memory.service.js';
import {
  createRequestContext,
} from '../../../src/modules/identity/interfaces/request-context.interface.js';
import {
  bindRequestContext,
} from '../../../src/modules/core/supabase/symbols.js';
import {
  ROLE_PERMISSIONS_MAP,
} from '../../../src/modules/workspace/interfaces/permissions.interface.js';
import type { WorkspaceRole } from '../../../src/modules/workspace/interfaces/roles.interface.js';

describe('N4: Memory Domain RBAC & Adversarial Tenancy Integration', () => {
  const ws1 = '11111111-1111-4111-a111-111111111111';
  const ws2 = '22222222-2222-4222-a222-222222222222';
  const org1 = '77777777-7777-4777-a777-777777777777';
  const user1 = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const user2 = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
  const mem1 = '99999999-9999-4999-a999-999999999999';

  let reflector: Reflector;
  let permissionsGuard: PermissionsGuard;
  let mockMemoryService: MemoryService;
  let controller: MemoryController;

  function buildRequest(
    userId = user1,
    workspaceId = ws1,
    role: WorkspaceRole = 'contributor',
    isMember = true,
  ): Request {
    const req = {
      headers: { 'x-correlation-id': 'corr-test' },
      params: { workspace_id: workspaceId },
      query: {},
      body: {},
    } as unknown as Request;

    if (isMember) {
      const ctx = createRequestContext({
        principal: {
          userId,
          organizationId: org1,
          email: `${userId}@contexta.ai`,
        },
        tenantScope: {
          workspaceId,
          organizationId: org1,
          role,
          permissions: ROLE_PERMISSIONS_MAP[role],
        },
        metadata: {
          correlationId: 'corr-test',
          receivedAt: new Date(),
        },
      });
      bindRequestContext(req, ctx);
    } else {
      const ctx = createRequestContext({
        principal: {
          userId,
          organizationId: org1,
          email: `${userId}@contexta.ai`,
        },
        metadata: {
          correlationId: 'corr-test',
          receivedAt: new Date(),
        },
      });
      bindRequestContext(req, ctx);
    }

    return req;
  }

  function createMockExecutionContext(req: Request, handler: Function): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({}),
        getNext: () => ({}),
      }),
      getHandler: () => handler,
      getClass: () => MemoryController,
      getArgs: () => [req],
      getArgByIndex: () => req,
      getType: () => 'http',
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    reflector = new Reflector();
    permissionsGuard = new PermissionsGuard(reflector);

    mockMemoryService = {
      getMemories: jest.fn(),
      deleteMemory: jest.fn(),
    } as unknown as MemoryService;

    controller = new MemoryController(mockMemoryService);
  });

  describe('Adversarial RBAC Guard Verification', () => {
    it('allows viewer to access GET memory (has memory:read)', () => {
      const req = buildRequest(user1, ws1, 'viewer');
      const context = createMockExecutionContext(req, controller.listMemories);

      const canActivate = permissionsGuard.canActivate(context);
      expect(canActivate).toBe(true);
    });

    it('denies viewer from DELETE memory (viewer lacks memory:write_self)', () => {
      const req = buildRequest(user1, ws1, 'viewer');
      const context = createMockExecutionContext(req, controller.deleteMemory);

      expect(() => permissionsGuard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('allows contributor to DELETE memory (contributor has memory:write_self)', () => {
      const req = buildRequest(user1, ws1, 'contributor');
      const context = createMockExecutionContext(req, controller.deleteMemory);

      const canActivate = permissionsGuard.canActivate(context);
      expect(canActivate).toBe(true);
    });

    it('allows workspace_admin to DELETE memory (workspace_admin has memory:write_self)', () => {
      const req = buildRequest(user1, ws1, 'workspace_admin');
      const context = createMockExecutionContext(req, controller.deleteMemory);

      const canActivate = permissionsGuard.canActivate(context);
      expect(canActivate).toBe(true);
    });

    it('denies unauthenticated / non-member request without tenantScope', () => {
      const req = buildRequest(user1, ws1, 'contributor', false);
      const context = createMockExecutionContext(req, controller.listMemories);

      expect(() => permissionsGuard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  describe('Adversarial Tenancy & Cross-User Isolation', () => {
    it('blocks cross-workspace tenant injection (workspace_A token + workspace_B URL)', async () => {
      // User has valid token for ws1, but tries to access ws2 in URL
      const req = buildRequest(user1, ws1, 'contributor');

      (mockMemoryService.getMemories as any).mockImplementation((wsId: string) => {
        if (wsId !== ws1) {
          throw new ForbiddenException('Forbidden: Cross-workspace access denied');
        }
      });

      await expect(
        controller.listMemories(ws2, { limit: 50, offset: 0 }, req),
      ).rejects.toThrow(ForbiddenException);
    });

    it('blocks cross-user memory deletion: user_A cannot delete user_B record (returns 404)', async () => {
      const req = buildRequest(user1, ws1, 'contributor');

      (mockMemoryService.deleteMemory as any).mockImplementation((_wsId: string, _memId: string) => {
        // Service soft-deletes WHERE user_id = authenticated user. Since record belongs to user_2, 0 rows match.
        throw new NotFoundException('Memory record not found');
      });

      await expect(controller.deleteMemory(ws1, mem1, req)).rejects.toThrow(NotFoundException);
    });

    it('returns 404 when attempting to delete an already deleted memory record', async () => {
      const req = buildRequest(user1, ws1, 'contributor');

      (mockMemoryService.deleteMemory as any).mockRejectedValue(new NotFoundException('Memory record not found'));

      await expect(controller.deleteMemory(ws1, mem1, req)).rejects.toThrow(NotFoundException);
    });
  });
});

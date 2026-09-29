import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  BadRequestException,
  NotFoundException,
  ValidationPipe,
  ParseUUIDPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { MemoryController } from '../../../src/modules/memory/controllers/memory.controller.js';
import { MemoryService } from '../../../src/modules/memory/services/memory.service.js';
import { GetMemoriesQueryDto } from '../../../src/modules/memory/dto/get-memories-query.dto.js';
import {
  createRequestContext,
} from '../../../src/modules/identity/interfaces/request-context.interface.js';
import {
  bindRequestContext,
} from '../../../src/modules/core/supabase/symbols.js';
import { ROLE_PERMISSIONS_MAP } from '../../../src/modules/workspace/interfaces/permissions.interface.js';
import type { WorkspaceRole } from '../../../src/modules/workspace/interfaces/roles.interface.js';
import { PERMISSIONS_KEY } from '../../../src/modules/workspace/decorators/require-permissions.decorator.js';

describe('N4: MemoryController Unit & Route Specification', () => {
  const validWsId = '33333333-3333-4333-a333-333333333333';
  const validUserId = '11111111-1111-4111-a111-111111111111';
  const validOrgId = '22222222-2222-4222-a222-222222222222';
  const validMemId = '99999999-9999-4999-a999-999999999999';
  const correlationId = 'corr-7777-4777-a777-777777777777';

  let mockMemoryService: MemoryService;
  let controller: MemoryController;
  let validationPipe: ValidationPipe;
  let uuidPipe: ParseUUIDPipe;

  function buildAuthenticatedRequest(
    userId = validUserId,
    workspaceId = validWsId,
    role: WorkspaceRole = 'contributor',
  ): Request {
    const req = {
      headers: { 'x-correlation-id': correlationId },
      params: { workspace_id: workspaceId, memory_id: validMemId },
      query: {},
      body: {},
    } as unknown as Request;

    const ctx = createRequestContext({
      principal: {
        userId,
        organizationId: validOrgId,
        email: 'dev@contexta.ai',
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
    mockMemoryService = {
      getMemories: jest.fn(),
      deleteMemory: jest.fn(),
    } as unknown as MemoryService;

    controller = new MemoryController(mockMemoryService);
    validationPipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
    uuidPipe = new ParseUUIDPipe({ version: '4' });
  });

  describe('Route Metadata & Guard Binding', () => {
    const reflector = new Reflector();

    it('attaches JwtAuthGuard, WorkspaceMemberGuard, and PermissionsGuard to controller', () => {
      const guards = Reflect.getMetadata('__guards__', MemoryController);
      expect(guards).toBeDefined();
      expect(guards.length).toBe(3);
      expect(guards.map((g: any) => g.name)).toEqual([
        'JwtAuthGuard',
        'WorkspaceMemberGuard',
        'PermissionsGuard',
      ]);
    });

    it('declares memory:read permission on listMemories (GET)', () => {
      const perms = reflector.get(PERMISSIONS_KEY, controller.listMemories);
      expect(perms).toEqual(['memory:read']);
    });

    it('declares memory:write_self permission on deleteMemory (DELETE)', () => {
      const perms = reflector.get(PERMISSIONS_KEY, controller.deleteMemory);
      expect(perms).toEqual(['memory:write_self']);
    });
  });

  describe('GET /v1/workspaces/:workspace_id/memory', () => {
    it('delegates to MemoryService and formats standard JSON envelope', async () => {
      const req = buildAuthenticatedRequest();
      const mockResult = {
        entries: [
          {
            id: validMemId,
            workspaceId: validWsId,
            userId: validUserId,
            visibility: 'user_private' as const,
            memoryType: 'user_preference' as const,
            content: 'Always format code in TypeScript',
            confidence: 0.95,
            sourceAgent: 'memory_agent',
            reason: 'User preference explicit statement',
            isDeleted: false,
            createdAt: '2026-09-29T00:00:00.000Z',
            updatedAt: '2026-09-29T00:00:00.000Z',
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      };

      (mockMemoryService.getMemories as any).mockResolvedValue(mockResult);

      const query: GetMemoriesQueryDto = { limit: 50, offset: 0 };
      const response = await controller.listMemories(validWsId, query, req);

      expect(mockMemoryService.getMemories).toHaveBeenCalledWith(
        validWsId,
        query,
        expect.objectContaining({ rawRequest: req }),
      );

      expect(response).toEqual({
        data: [
          {
            id: validMemId,
            workspace_id: validWsId,
            user_id: validUserId,
            visibility: 'user_private',
            memory_type: 'user_preference',
            content: 'Always format code in TypeScript',
            confidence: 0.95,
            source_agent: 'memory_agent',
            reason: 'User preference explicit statement',
            created_at: '2026-09-29T00:00:00.000Z',
            updated_at: '2026-09-29T00:00:00.000Z',
          },
        ],
        meta: {
          total: 1,
          limit: 50,
          offset: 0,
        },
      });
    });

    it('rejects invalid query parameters via ValidationPipe (limit > 100)', async () => {
      const invalidQuery = { limit: 150, offset: 0 };
      await expect(
        validationPipe.transform(invalidQuery, { type: 'query', metatype: GetMemoriesQueryDto }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects negative offset via ValidationPipe', async () => {
      const invalidQuery = { limit: 10, offset: -5 };
      await expect(
        validationPipe.transform(invalidQuery, { type: 'query', metatype: GetMemoriesQueryDto }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects non-whitelisted query properties', async () => {
      const maliciousQuery = { limit: 10, offset: 0, inject_sql: 'DROP TABLE memory_entries' };
      await expect(
        validationPipe.transform(maliciousQuery, { type: 'query', metatype: GetMemoriesQueryDto }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('DELETE /v1/workspaces/:workspace_id/memory/:memory_id', () => {
    it('delegates to MemoryService and returns standard delete response', async () => {
      const req = buildAuthenticatedRequest();
      (mockMemoryService.deleteMemory as any).mockResolvedValue({
        id: validMemId,
        isDeleted: true,
      });

      const response = await controller.deleteMemory(validWsId, validMemId, req);

      expect(mockMemoryService.deleteMemory).toHaveBeenCalledWith(
        validWsId,
        validMemId,
        expect.objectContaining({ rawRequest: req }),
      );

      expect(response).toEqual({
        data: {
          success: true,
          id: validMemId,
          is_deleted: true,
        },
      });
    });

    it('rejects non-UUID memory_id parameter via ParseUUIDPipe', async () => {
      await expect(uuidPipe.transform('invalid-uuid-123', { type: 'param', data: 'memory_id' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('propagates NotFoundException from service when memory entry does not exist', async () => {
      const req = buildAuthenticatedRequest();
      (mockMemoryService.deleteMemory as any).mockRejectedValue(new NotFoundException('Memory record not found'));

      await expect(controller.deleteMemory(validWsId, validMemId, req)).rejects.toThrow(NotFoundException);
    });
  });
});

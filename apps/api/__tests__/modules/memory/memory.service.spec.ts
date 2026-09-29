import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  ForbiddenException,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import type { Request } from 'express';
import { MemoryService } from '../../../src/modules/memory/services/memory.service.js';
import { SupabaseService } from '../../../src/modules/core/supabase/supabase.service.js';
import {
  createRequestContext,
} from '../../../src/modules/identity/interfaces/request-context.interface.js';
import {
  bindRequestContext,
} from '../../../src/modules/core/supabase/symbols.js';
import { createRequestExecutionContext } from '../../../src/modules/core/interfaces/request-execution-context.interface.js';
import { ROLE_PERMISSIONS_MAP } from '../../../src/modules/workspace/interfaces/permissions.interface.js';
import type { WorkspaceRole } from '../../../src/modules/workspace/interfaces/roles.interface.js';

describe('N4: MemoryService Domain & Tenancy Specification', () => {
  const validWsId = '33333333-3333-4333-a333-333333333333';
  const otherWsId = '44444444-4444-4444-a444-444444444444';
  const validUserId = '11111111-1111-4111-a111-111111111111';
  const validOrgId = '77777777-7777-4777-a777-777777777777';
  const validMemId = '99999999-9999-4999-a999-999999999999';

  let mockSupabaseClient: any;
  let mockSupabaseService: SupabaseService;
  let service: MemoryService;

  function buildRequest(
    userId = validUserId,
    workspaceId = validWsId,
    role: WorkspaceRole = 'contributor',
  ): Request {
    const req = {
      headers: { 'x-correlation-id': 'test-corr-id' },
      params: { workspace_id: workspaceId },
      query: {},
      body: {},
    } as unknown as Request;

    const ctx = createRequestContext({
      principal: {
        userId,
        organizationId: validOrgId,
        email: 'user@contexta.ai',
      },
      tenantScope: {
        workspaceId,
        organizationId: validOrgId,
        role,
        permissions: ROLE_PERMISSIONS_MAP[role],
      },
      metadata: {
        correlationId: 'test-corr-id',
        receivedAt: new Date(),
      },
    });

    bindRequestContext(req, ctx);
    return req;
  }

  beforeEach(() => {
    mockSupabaseClient = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockReturnThis(),
    };

    mockSupabaseService = {
      getClient: jest.fn().mockReturnValue(mockSupabaseClient),
    } as unknown as SupabaseService;

    service = new MemoryService(undefined, mockSupabaseService);
  });

  describe('getMemories() Tenancy & Filtering', () => {
    it('enforces compound filter: workspace_id, user_id, and is_deleted = false', async () => {
      const req = buildRequest();
      const execContext = createRequestExecutionContext(req);

      const fakeRows = [
        {
          id: validMemId,
          workspace_id: validWsId,
          user_id: validUserId,
          visibility: 'user_private',
          memory_type: 'user_preference',
          content: 'Dark mode preferred',
          confidence: 1.0,
          source_agent: 'memory_agent',
          reason: 'User stated preference',
          is_deleted: false,
          created_at: '2026-09-29T01:00:00Z',
          updated_at: '2026-09-29T01:00:00Z',
        },
      ];

      mockSupabaseClient.range.mockResolvedValue({
        data: fakeRows,
        error: null,
        count: 1,
      });

      const result = await service.getMemories(validWsId, { limit: 50, offset: 0 }, execContext);

      expect(mockSupabaseClient.from).toHaveBeenCalledWith('memory_entries');
      expect(mockSupabaseClient.eq).toHaveBeenCalledWith('workspace_id', validWsId);
      expect(mockSupabaseClient.eq).toHaveBeenCalledWith('user_id', validUserId);
      expect(mockSupabaseClient.eq).toHaveBeenCalledWith('is_deleted', false);
      expect(mockSupabaseClient.order).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(mockSupabaseClient.order).toHaveBeenCalledWith('id', { ascending: false });
      expect(mockSupabaseClient.range).toHaveBeenCalledWith(0, 49);

      expect(result.entries.length).toBe(1);
      expect(result.entries[0].content).toBe('Dark mode preferred');
      expect(result.total).toBe(1);
    });

    it('rejects cross-workspace retrieval if requested workspaceId != tenantScope.workspaceId', async () => {
      const req = buildRequest(validUserId, validWsId);
      const execContext = createRequestExecutionContext(req);

      await expect(
        service.getMemories(otherWsId, { limit: 50, offset: 0 }, execContext),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws ForbiddenException if RequestContext is missing', async () => {
      const req = {} as Request;
      const execContext = createRequestExecutionContext(req);

      await expect(
        service.getMemories(validWsId, { limit: 50, offset: 0 }, execContext),
      ).rejects.toThrow(ForbiddenException);
    });

    it('maps database errors to InternalServerErrorException', async () => {
      const req = buildRequest();
      const execContext = createRequestExecutionContext(req);

      mockSupabaseClient.range.mockResolvedValue({
        data: null,
        error: { message: 'PostgreSQL connection timeout' },
        count: null,
      });

      await expect(
        service.getMemories(validWsId, { limit: 50, offset: 0 }, execContext),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('deleteMemory() Soft Delete & Invariants', () => {
    it('executes UPDATE setting is_deleted = true with compound scoping', async () => {
      const req = buildRequest();
      const execContext = createRequestExecutionContext(req);

      mockSupabaseClient.select.mockResolvedValue({
        data: [{ id: validMemId, is_deleted: true }],
        error: null,
      });

      const result = await service.deleteMemory(validWsId, validMemId, execContext);

      expect(mockSupabaseClient.from).toHaveBeenCalledWith('memory_entries');
      expect(mockSupabaseClient.update).toHaveBeenCalledWith(
        expect.objectContaining({
          is_deleted: true,
          updated_at: expect.any(String),
        }),
      );
      expect(mockSupabaseClient.eq).toHaveBeenCalledWith('id', validMemId);
      expect(mockSupabaseClient.eq).toHaveBeenCalledWith('workspace_id', validWsId);
      expect(mockSupabaseClient.eq).toHaveBeenCalledWith('user_id', validUserId);
      expect(mockSupabaseClient.eq).toHaveBeenCalledWith('is_deleted', false);

      expect(result).toEqual({
        id: validMemId,
        isDeleted: true,
      });
    });

    it('throws NotFoundException when no matching active row was updated', async () => {
      const req = buildRequest();
      const execContext = createRequestExecutionContext(req);

      mockSupabaseClient.select.mockResolvedValue({
        data: [],
        error: null,
      });

      await expect(
        service.deleteMemory(validWsId, validMemId, execContext),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects cross-workspace deletion when workspaceId != RequestContext.workspaceId', async () => {
      const req = buildRequest(validUserId, validWsId);
      const execContext = createRequestExecutionContext(req);

      await expect(
        service.deleteMemory(otherWsId, validMemId, execContext),
      ).rejects.toThrow(ForbiddenException);
    });

    it('maps database update failure to InternalServerErrorException', async () => {
      const req = buildRequest();
      const execContext = createRequestExecutionContext(req);

      mockSupabaseClient.select.mockResolvedValue({
        data: null,
        error: { message: 'Database RLS policy violation' },
      });

      await expect(
        service.deleteMemory(validWsId, validMemId, execContext),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });
});

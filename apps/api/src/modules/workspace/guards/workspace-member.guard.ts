import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  NotFoundException,
  Optional,
  Inject,
} from '@nestjs/common';
import { ModuleRef, ContextIdFactory } from '@nestjs/core';
import type { Request } from 'express';
import { getRequestContext, bindRequestContext } from '../../core/supabase/symbols.js';
import { createRequestContext } from '../../identity/interfaces/request-context.interface.js';
import type { TenantScope } from '../../identity/interfaces/request-context.interface.js';
import { WORKSPACE_ROLES, type WorkspaceRole } from '../interfaces/roles.interface.js';
import { ROLE_PERMISSIONS_MAP } from '../interfaces/permissions.interface.js';
import { SupabaseService } from '../../core/supabase/supabase.service.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WorkspaceMembership {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

/**
 * Provider interface for querying workspace membership state.
 */
export interface WorkspaceMembershipProvider {
  findMembership(workspaceId: string, userId: string): Promise<WorkspaceMembership | null>;
}

export const WORKSPACE_MEMBERSHIP_PROVIDER: unique symbol = Symbol('WORKSPACE_MEMBERSHIP_PROVIDER');

/**
 * Layer 2 Tenancy Pre-flight Guard: Workspace membership and role resolution.
 *
 * Responsibilities:
 * 1. Extract workspace resource ID from route parameters.
 * 2. Validate authenticated principal exists (401 if unauthenticated).
 * 3. Query authoritative public.workspace_members for caller's membership.
 * 4. Resolve canonical role and discrete capability permissions.
 * 5. Construct and bind immutable TenantScope to RequestContext.
 *
 * Security Invariants:
 * - workspace_id is treated strictly as a resource identifier, never an authentication claim.
 * - Queries execute under caller's request-scoped authenticated Supabase client (RLS-enforced).
 * - Client-supplied roles (in body, query, params, headers) are NEVER trusted.
 * - Non-existent, hidden (RLS), or non-member workspaces fail closed with 404 Not Found (anti-enumeration).
 * - Missing or malformed workspace UUIDs fail with 403 Forbidden.
 * - Does NOT use service-role key or admin client.
 */
@Injectable()
export class WorkspaceMemberGuard implements CanActivate {
  private readonly membershipProvider?: WorkspaceMembershipProvider;
  private readonly moduleRef?: ModuleRef;

  constructor(
    @Optional()
    @Inject(ModuleRef)
    moduleRef?: ModuleRef | WorkspaceMembershipProvider,
    @Optional()
    @Inject(WORKSPACE_MEMBERSHIP_PROVIDER)
    membershipProvider?: WorkspaceMembershipProvider,
  ) {
    if (
      moduleRef &&
      typeof (moduleRef as unknown as WorkspaceMembershipProvider).findMembership === 'function'
    ) {
      this.membershipProvider = moduleRef as unknown as WorkspaceMembershipProvider;
      this.moduleRef = undefined;
    } else {
      this.moduleRef = moduleRef as ModuleRef | undefined;
      this.membershipProvider = membershipProvider;
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    if (!request) {
      throw new UnauthorizedException('Authentication required');
    }

    // 1. Verify authentication state (Layer 1 must have run)
    const requestContext = getRequestContext(request);
    if (!requestContext || !requestContext.principal || !requestContext.principal.userId) {
      throw new UnauthorizedException('Authentication required');
    }

    // 2. Extract and validate target workspace ID from route parameters (:workspace_id or :workspaceId)
    const params = (request.params ?? {}) as Record<string, string | undefined>;
    const rawWorkspaceId = params.workspace_id ?? params.workspaceId;

    if (!rawWorkspaceId || typeof rawWorkspaceId !== 'string' || !UUID_REGEX.test(rawWorkspaceId.trim())) {
      throw new ForbiddenException('Forbidden: Missing or invalid workspace identifier');
    }

    const workspaceId = rawWorkspaceId.trim();
    const userId = requestContext.principal.userId;

    // Check existing tenantScope: if already present and conflicts with requested workspace, fail closed
    if (requestContext.tenantScope && requestContext.tenantScope.workspaceId !== workspaceId) {
      throw new ForbiddenException('Forbidden: Conflicting tenant context');
    }

    // 3. Resolve membership record
    let membership: WorkspaceMembership | null = null;

    if (this.membershipProvider) {
      membership = await this.membershipProvider.findMembership(workspaceId, userId);
    } else if (this.moduleRef) {
      const contextId = ContextIdFactory.getByRequest(request);
      this.moduleRef.registerRequestByContextId(request, contextId);
      const supabaseService = await this.moduleRef.resolve(SupabaseService, contextId, { strict: false });
      if (!supabaseService) {
        throw new ForbiddenException('Forbidden: Database infrastructure unavailable');
      }

      const client = supabaseService.getClient();
      const { data, error } = await client
        .from('workspace_members')
        .select('workspace_id, user_id, role')
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId)
        .single();

      if (!error && data) {
        membership = {
          workspaceId: data.workspace_id,
          userId: data.user_id,
          role: data.role as WorkspaceRole,
        };
      }
    } else {
      throw new ForbiddenException('Forbidden: Membership verification provider not configured');
    }

    // 4. Fail closed with 404 (anti-enumeration) if membership is not found (or hidden by RLS)
    if (!membership) {
      throw new NotFoundException('Workspace not found');
    }

    // 5. Validate canonical role
    const role = membership.role;
    if (!role || !WORKSPACE_ROLES.includes(role)) {
      throw new ForbiddenException('Forbidden: Invalid or unrecognized workspace role');
    }

    // 6. Map discrete capability permissions
    const permissions = ROLE_PERMISSIONS_MAP[role];
    if (!permissions) {
      throw new ForbiddenException('Forbidden: Role capability permissions not configured');
    }

    // 7. Check for existing tenantScope: reject conflicting context or allow idempotent match
    if (requestContext.tenantScope) {
      if (
        requestContext.tenantScope.workspaceId === workspaceId &&
        requestContext.tenantScope.role === role
      ) {
        return true;
      }
      throw new ForbiddenException('Forbidden: Conflicting tenant context');
    }

    // 8. Construct TenantScope and bind enriched RequestContext
    const tenantScope: TenantScope = {
      workspaceId,
      organizationId: requestContext.principal.organizationId,
      role,
      permissions,
    };

    const enrichedContext = createRequestContext({
      principal: requestContext.principal,
      tenantScope,
      metadata: requestContext.metadata,
    });

    bindRequestContext(request, enrichedContext);

    return true;
  }
}

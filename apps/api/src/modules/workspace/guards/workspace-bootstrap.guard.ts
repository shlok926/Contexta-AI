import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  Optional,
  Inject,
} from '@nestjs/common';
import { ModuleRef, ContextIdFactory } from '@nestjs/core';
import type { Request } from 'express';
import { getRequestContext } from '../../core/supabase/symbols.js';
import { WORKSPACE_ROLES, type WorkspaceRole } from '../interfaces/roles.interface.js';
import { SupabaseService } from '../../core/supabase/supabase.service.js';

export interface WorkspaceBootstrapMembership {
  workspaceId: string;
  role: WorkspaceRole;
}

/**
 * Provider interface for querying a user's memberships during bootstrap pre-flight.
 */
export interface WorkspaceBootstrapProvider {
  getUserMemberships(userId: string): Promise<WorkspaceBootstrapMembership[]>;
}

export const WORKSPACE_BOOTSTRAP_PROVIDER: unique symbol = Symbol('WORKSPACE_BOOTSTRAP_PROVIDER');

/**
 * Layer 2 Tenancy Pre-flight Guard: Workspace Bootstrap Pre-Flight Authorization.
 *
 * Responsibilities:
 * 1. Validate caller is authenticated (Layer 1 JwtAuthGuard must have run -> 401 if unauthenticated).
 * 2. Pre-flight evaluation of first-workspace vs subsequent workspace creation policy:
 *    - Case A: Caller has zero visible workspaces -> active authenticated user is eligible
 *      for first-workspace creation (avoids circular dependency / bootstrap deadlock).
 *    - Case B: Caller has 1 or more existing workspaces -> strictly requires 'org_admin' role
 *      in an existing workspace to provision additional workspaces.
 *
 * Security Invariants:
 * - This guard is ADVISORY pre-flight ONLY.
 * - public.bootstrap_workspace(p_name text) (SECURITY DEFINER RPC with advisory lock) is
 *   the authoritative database authorization, serialization, and atomicity boundary.
 * - This guard NEVER performs workspace or membership database writes.
 * - PermissionsGuard is deliberately EXCLUDED from POST /v1/workspaces to prevent deadlock.
 * - Queries execute under caller's request-scoped authenticated Supabase client (RLS-enforced).
 * - Zero service-role keys or raw pg connections are used.
 */
@Injectable()
export class WorkspaceBootstrapGuard implements CanActivate {
  private readonly bootstrapProvider?: WorkspaceBootstrapProvider;
  private readonly moduleRef?: ModuleRef;

  constructor(
    @Optional()
    @Inject(ModuleRef)
    moduleRef?: ModuleRef | WorkspaceBootstrapProvider,
    @Optional()
    @Inject(WORKSPACE_BOOTSTRAP_PROVIDER)
    bootstrapProvider?: WorkspaceBootstrapProvider,
  ) {
    if (
      moduleRef &&
      typeof (moduleRef as unknown as WorkspaceBootstrapProvider).getUserMemberships === 'function'
    ) {
      this.bootstrapProvider = moduleRef as unknown as WorkspaceBootstrapProvider;
      this.moduleRef = undefined;
    } else {
      this.moduleRef = moduleRef as ModuleRef | undefined;
      this.bootstrapProvider = bootstrapProvider;
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

    const userId = requestContext.principal.userId;
    let memberships: WorkspaceBootstrapMembership[] = [];

    // 2. Query user's existing memberships via request-scoped PostgREST client
    if (this.bootstrapProvider) {
      const res = await this.bootstrapProvider.getUserMemberships(userId);
      memberships = Array.isArray(res) ? res : [];
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
        .select('workspace_id, role')
        .eq('user_id', userId);

      if (error) {
        throw new ForbiddenException('Forbidden: Unable to verify workspace authorization');
      }

      if (data && Array.isArray(data)) {
        memberships = data
          .filter((row) => row.workspace_id && row.role && WORKSPACE_ROLES.includes(row.role as WorkspaceRole))
          .map((row) => ({
            workspaceId: row.workspace_id,
            role: row.role as WorkspaceRole,
          }));
      }
    } else {
      throw new ForbiddenException('Forbidden: Bootstrap verification provider not configured');
    }

    // 3. Case A: Zero existing memberships -> Eligible for first-workspace bootstrap
    if (memberships.length === 0) {
      return true;
    }

    // 4. Case B: One or more existing memberships -> Strictly requires org_admin role
    const isOrgAdmin = memberships.some((m) => m.role === 'org_admin');
    if (!isOrgAdmin) {
      throw new ForbiddenException(
        'Forbidden: Only organization administrators can create additional workspaces',
      );
    }

    return true;
  }
}

import type { AuthenticatedPrincipal } from './principal.interface.js';
import type { WorkspaceRole } from '../../workspace/interfaces/roles.interface.js';
import type { PermissionsMap } from '../../workspace/interfaces/permissions.interface.js';

export type { AuthenticatedPrincipal };

/**
 * Tenant scope information established during pre-flight workspace scoping.
 */
export interface TenantScope {
  /** Validated workspace UUID from route parameters */
  readonly workspaceId: string;

  /** Parent organization UUID of the workspace */
  readonly organizationId: string;

  /** Caller's canonical role within this workspace */
  readonly role: WorkspaceRole;

  /** Genuinely immutable frozen dictionary of active permissions */
  readonly permissions: PermissionsMap;
}

/**
 * Request-level correlation and ingress telemetry metadata.
 */
export interface RequestMetadata {
  /** Distributed correlation ID (from X-Correlation-ID or server UUID) */
  readonly correlationId: string;

  /** Ingress timestamp when request entered the gateway */
  readonly receivedAt: Date;
}

/**
 * Strongly typed, immutable, token-free request execution context.
 * Constructed exclusively by authentication/authorization guards and
 * passed to domain/application services.
 */
export interface RequestContext {
  /** Authenticated human principal */
  readonly principal: AuthenticatedPrincipal;

  /** Workspace-scoped tenancy context (present on workspace-scoped routes) */
  readonly tenantScope?: TenantScope;

  /** Ingress and correlation metadata */
  readonly metadata: RequestMetadata;
}

/**
 * Parameters for constructing an immutable RequestContext.
 */
export interface CreateRequestContextParams {
  principal: AuthenticatedPrincipal;
  tenantScope?: TenantScope;
  metadata: RequestMetadata;
}

/**
 * Creates and deeply freezes a RequestContext instance, ensuring physical runtime immutability.
 * In strict mode, any attempt to mutate properties on the returned object or its nested
 * structures will throw a TypeError.
 */
export function createRequestContext(params: CreateRequestContextParams): RequestContext {
  const frozenPrincipal = Object.freeze({ ...params.principal });
  const frozenMetadata = Object.freeze({ ...params.metadata });

  let frozenTenantScope: TenantScope | undefined;
  if (params.tenantScope) {
    const frozenPermissions = Object.freeze({ ...params.tenantScope.permissions });
    frozenTenantScope = Object.freeze({
      workspaceId: params.tenantScope.workspaceId,
      organizationId: params.tenantScope.organizationId,
      role: params.tenantScope.role,
      permissions: frozenPermissions,
    });
  }

  return Object.freeze({
    principal: frozenPrincipal,
    tenantScope: frozenTenantScope,
    metadata: frozenMetadata,
  });
}

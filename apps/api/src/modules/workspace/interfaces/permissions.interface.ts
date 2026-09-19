import type { WorkspaceRole } from './roles.interface.js';

/**
 * Canonical 17 atomic capabilities across the system.
 * Defined in ADR-0008 §10.2 and Phase N2 implementation plan §10.1.
 */
export type Permission =
  | 'workspace:create'
  | 'workspace:read'
  | 'workspace:update'
  | 'workspace:delete'
  | 'member:read'
  | 'member:manage'
  | 'document:read'
  | 'document:upload'
  | 'document:delete'
  | 'thread:read'
  | 'thread:create'
  | 'run:execute'
  | 'run:cancel'
  | 'memory:read'
  | 'memory:write_self'
  | 'memory:write_shared'
  | 'audit:read';

/**
 * Immutable permission dictionary mapping active permissions to true.
 * Applying Object.freeze() to this plain dictionary provides physical runtime immutability.
 */
export type PermissionsMap = Readonly<Partial<Record<Permission, true>>>;

/**
 * Canonical role-to-permission dictionary mapping for the four workspace roles.
 * Treated as discrete capability bundles (non-ordinal).
 */
export const ROLE_PERMISSIONS_MAP: Readonly<Record<WorkspaceRole, PermissionsMap>> = Object.freeze({
  viewer: Object.freeze({
    'workspace:read': true,
    'member:read': true,
    'document:read': true,
    'thread:read': true,
    'memory:read': true,
  }),
  contributor: Object.freeze({
    'workspace:read': true,
    'member:read': true,
    'document:read': true,
    'document:upload': true,
    'thread:read': true,
    'thread:create': true,
    'run:execute': true,
    'run:cancel': true,
    'memory:read': true,
    'memory:write_self': true,
  }),
  workspace_admin: Object.freeze({
    'workspace:read': true,
    'workspace:update': true,
    'member:read': true,
    'member:manage': true,
    'document:read': true,
    'document:upload': true,
    'document:delete': true,
    'thread:read': true,
    'thread:create': true,
    'run:execute': true,
    'run:cancel': true,
    'memory:read': true,
    'memory:write_self': true,
    'memory:write_shared': true,
    'audit:read': true,
  }),
  org_admin: Object.freeze({
    'workspace:create': true,
    'workspace:read': true,
    'workspace:update': true,
    'workspace:delete': true,
    'member:read': true,
    'member:manage': true,
    'document:read': true,
    'document:upload': true,
    'document:delete': true,
    'thread:read': true,
    'thread:create': true,
    'run:execute': true,
    'run:cancel': true,
    'memory:read': true,
    'memory:write_self': true,
    'memory:write_shared': true,
    'audit:read': true,
  }),
});

export const ALL_PERMISSIONS: readonly Permission[] = Object.freeze([
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

/**
 * Validates whether an arbitrary value is a canonical Permission.
 */
export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (ALL_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Evaluates whether a role or a frozen permissions map contains a required permission.
 * Fails closed (returns false) on unknown roles, invalid permissions, or falsy inputs.
 */
export function hasPermission(
  target: WorkspaceRole | PermissionsMap | undefined | null | string,
  permission: Permission | string,
): boolean {
  if (!target || !permission || !isPermission(permission)) {
    return false;
  }

  // If target is a WorkspaceRole string
  if (typeof target === 'string') {
    const rolePermissions = ROLE_PERMISSIONS_MAP[target as WorkspaceRole];
    if (!rolePermissions) {
      return false;
    }
    return rolePermissions[permission] === true;
  }

  // If target is a PermissionsMap object
  if (typeof target === 'object') {
    return target[permission] === true;
  }

  return false;
}


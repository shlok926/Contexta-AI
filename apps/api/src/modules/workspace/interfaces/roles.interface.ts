/**
 * Canonical workspace roles in snake_case format.
 * Must match the database check constraint in public.workspace_members.
 */
export type WorkspaceRole = 'viewer' | 'contributor' | 'workspace_admin' | 'org_admin';

export const WORKSPACE_ROLES: readonly WorkspaceRole[] = Object.freeze([
  'viewer',
  'contributor',
  'workspace_admin',
  'org_admin',
]);

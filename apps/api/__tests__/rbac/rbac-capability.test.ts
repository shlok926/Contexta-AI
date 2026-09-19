import { Reflector } from '@nestjs/core';
import {
  type Permission,
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS_MAP,
  hasPermission,
  isPermission,
} from '../../src/modules/workspace/interfaces/permissions.interface.js';
import {
  type WorkspaceRole,
  WORKSPACE_ROLES,
} from '../../src/modules/workspace/interfaces/roles.interface.js';
import {
  RequirePermissions,
  PERMISSIONS_KEY,
} from '../../src/modules/workspace/decorators/require-permissions.decorator.js';

describe('N2.6 RBAC Capabilities, Canonical Permission Dictionary & Decorators', () => {
  // =========================================================================
  // 1. CANONICAL ROLES
  // =========================================================================
  describe('Canonical Roles', () => {
    it('should declare exactly 4 canonical roles in lowercase snake_case', () => {
      expect(WORKSPACE_ROLES).toEqual(['viewer', 'contributor', 'workspace_admin', 'org_admin']);
      expect(WORKSPACE_ROLES.length).toBe(4);
    });

    it('should physically freeze the WORKSPACE_ROLES array against mutation', () => {
      expect(Object.isFrozen(WORKSPACE_ROLES)).toBe(true);
      expect(() => {
        (WORKSPACE_ROLES as unknown as string[]).push('super_admin');
      }).toThrow(TypeError);
    });
  });

  // =========================================================================
  // 2. CANONICAL PERMISSIONS
  // =========================================================================
  describe('Canonical Permissions', () => {
    const EXPECTED_17_PERMISSIONS: readonly Permission[] = [
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
    ];

    it('should declare exactly 17 canonical permissions', () => {
      expect(ALL_PERMISSIONS.length).toBe(17);
      expect([...ALL_PERMISSIONS].sort()).toEqual([...EXPECTED_17_PERMISSIONS].sort());
    });

    it('should physically freeze the ALL_PERMISSIONS array against mutation', () => {
      expect(Object.isFrozen(ALL_PERMISSIONS)).toBe(true);
      expect(() => {
        (ALL_PERMISSIONS as unknown as string[]).push('invalid:permission');
      }).toThrow(TypeError);
    });

    it('should accurately validate canonical permissions via isPermission type guard', () => {
      for (const perm of EXPECTED_17_PERMISSIONS) {
        expect(isPermission(perm)).toBe(true);
      }
      expect(isPermission('workspace:destroy')).toBe(false);
      expect(isPermission('admin:all')).toBe(false);
      expect(isPermission('')).toBe(false);
      expect(isPermission(null)).toBe(false);
      expect(isPermission(undefined)).toBe(false);
      expect(isPermission(123)).toBe(false);
    });
  });

  // =========================================================================
  // 3. CANONICAL ROLE → PERMISSION MATRIX & DISCRETE CAPABILITY BUNDLES
  // =========================================================================
  describe('Canonical Role → Permission Matrix (ROLE_PERMISSIONS_MAP)', () => {
    it('should define entries for all 4 canonical roles and no additional roles', () => {
      expect(Object.keys(ROLE_PERMISSIONS_MAP).sort()).toEqual(
        ['viewer', 'contributor', 'workspace_admin', 'org_admin'].sort(),
      );
    });

    it('should freeze ROLE_PERMISSIONS_MAP and every nested permission dictionary', () => {
      expect(Object.isFrozen(ROLE_PERMISSIONS_MAP)).toBe(true);
      for (const role of WORKSPACE_ROLES) {
        expect(Object.isFrozen(ROLE_PERMISSIONS_MAP[role])).toBe(true);
      }
    });

    it('should reject runtime mutation on ROLE_PERMISSIONS_MAP', () => {
      expect(() => {
        (ROLE_PERMISSIONS_MAP as unknown as Record<string, unknown>).viewer = {};
      }).toThrow(TypeError);

      expect(() => {
        (ROLE_PERMISSIONS_MAP.viewer as unknown as Record<string, boolean>)['document:upload'] = true;
      }).toThrow(TypeError);
    });

    it('should map viewer to exact discrete capabilities (5 permissions)', () => {
      const viewerPerms = ROLE_PERMISSIONS_MAP.viewer;
      expect(Object.keys(viewerPerms).length).toBe(5);

      // Allowed (5)
      expect(hasPermission('viewer', 'workspace:read')).toBe(true);
      expect(hasPermission('viewer', 'member:read')).toBe(true);
      expect(hasPermission('viewer', 'document:read')).toBe(true);
      expect(hasPermission('viewer', 'thread:read')).toBe(true);
      expect(hasPermission('viewer', 'memory:read')).toBe(true);

      // Denied
      expect(hasPermission('viewer', 'document:upload')).toBe(false);
      expect(hasPermission('viewer', 'document:delete')).toBe(false);
      expect(hasPermission('viewer', 'workspace:create')).toBe(false);
      expect(hasPermission('viewer', 'workspace:update')).toBe(false);
      expect(hasPermission('viewer', 'workspace:delete')).toBe(false);
      expect(hasPermission('viewer', 'member:manage')).toBe(false);
      expect(hasPermission('viewer', 'thread:create')).toBe(false);
      expect(hasPermission('viewer', 'run:execute')).toBe(false);
      expect(hasPermission('viewer', 'run:cancel')).toBe(false);
      expect(hasPermission('viewer', 'memory:write_self')).toBe(false);
      expect(hasPermission('viewer', 'memory:write_shared')).toBe(false);
      expect(hasPermission('viewer', 'audit:read')).toBe(false);
    });

    it('should map contributor to exact discrete capabilities (10 permissions)', () => {
      const contributorPerms = ROLE_PERMISSIONS_MAP.contributor;
      expect(Object.keys(contributorPerms).length).toBe(10);

      // Allowed (10)
      expect(hasPermission('contributor', 'workspace:read')).toBe(true);
      expect(hasPermission('contributor', 'member:read')).toBe(true);
      expect(hasPermission('contributor', 'document:read')).toBe(true);
      expect(hasPermission('contributor', 'document:upload')).toBe(true);
      expect(hasPermission('contributor', 'thread:read')).toBe(true);
      expect(hasPermission('contributor', 'thread:create')).toBe(true);
      expect(hasPermission('contributor', 'run:execute')).toBe(true);
      expect(hasPermission('contributor', 'run:cancel')).toBe(true);
      expect(hasPermission('contributor', 'memory:read')).toBe(true);
      expect(hasPermission('contributor', 'memory:write_self')).toBe(true);

      // Denied
      expect(hasPermission('contributor', 'workspace:create')).toBe(false);
      expect(hasPermission('contributor', 'workspace:update')).toBe(false);
      expect(hasPermission('contributor', 'workspace:delete')).toBe(false);
      expect(hasPermission('contributor', 'member:manage')).toBe(false);
      expect(hasPermission('contributor', 'document:delete')).toBe(false);
      expect(hasPermission('contributor', 'memory:write_shared')).toBe(false);
      expect(hasPermission('contributor', 'audit:read')).toBe(false);
    });

    it('should map workspace_admin to exact discrete capabilities (15 permissions)', () => {
      const adminPerms = ROLE_PERMISSIONS_MAP.workspace_admin;
      expect(Object.keys(adminPerms).length).toBe(15);

      // workspace_admin cannot create or delete workspaces (org-level provisioning/destruction)
      expect(hasPermission('workspace_admin', 'workspace:create')).toBe(false);
      expect(hasPermission('workspace_admin', 'workspace:delete')).toBe(false);

      // All other 15 capabilities allowed
      const allowedAdminPerms = ALL_PERMISSIONS.filter(
        (p) => p !== 'workspace:create' && p !== 'workspace:delete',
      );
      for (const perm of allowedAdminPerms) {
        expect(hasPermission('workspace_admin', perm)).toBe(true);
      }
    });

    it('should map org_admin to all 17 canonical capabilities', () => {
      const orgAdminPerms = ROLE_PERMISSIONS_MAP.org_admin;
      expect(Object.keys(orgAdminPerms).length).toBe(17);

      for (const perm of ALL_PERMISSIONS) {
        expect(hasPermission('org_admin', perm)).toBe(true);
      }
    });
  });

  // =========================================================================
  // 4. NON-ORDINAL CAPABILITY EVALUATION TESTS
  // =========================================================================
  describe('Non-Ordinal Capability Principles', () => {
    it('should evaluate permissions discretely without numeric rank assumptions', () => {
      // workspace_admin has more capabilities than contributor, but capabilities are checked discretely:
      expect(hasPermission('workspace_admin', 'workspace:create')).toBe(false);
      expect(hasPermission('org_admin', 'workspace:create')).toBe(true);

      // Permissions cannot be inferred from role name comparisons
      expect(hasPermission('contributor', 'document:delete')).toBe(false);
      expect(hasPermission('workspace_admin', 'document:delete')).toBe(true);
    });
  });

  // =========================================================================
  // 5. hasPermission HELPER & FAIL-CLOSED VALIDATION
  // =========================================================================
  describe('hasPermission Helper & Fail-Closed Invariants', () => {
    it('should support evaluation by WorkspaceRole string', () => {
      expect(hasPermission('viewer', 'document:read')).toBe(true);
      expect(hasPermission('viewer', 'document:upload')).toBe(false);
    });

    it('should support evaluation by frozen PermissionsMap object', () => {
      const map = ROLE_PERMISSIONS_MAP.contributor;
      expect(hasPermission(map, 'document:upload')).toBe(true);
      expect(hasPermission(map, 'document:delete')).toBe(false);
    });

    it('should fail closed (return false) for unknown/invalid roles', () => {
      expect(hasPermission('super_admin' as WorkspaceRole, 'document:read')).toBe(false);
      expect(hasPermission('admin' as WorkspaceRole, 'document:read')).toBe(false);
      expect(hasPermission('owner' as WorkspaceRole, 'document:read')).toBe(false);
      expect(hasPermission('member' as WorkspaceRole, 'document:read')).toBe(false);
      expect(hasPermission('root' as WorkspaceRole, 'document:read')).toBe(false);
      expect(hasPermission('' as WorkspaceRole, 'document:read')).toBe(false);
    });

    it('should fail closed (return false) for unknown/invalid permissions', () => {
      expect(hasPermission('org_admin', 'workspace:destroy' as Permission)).toBe(false);
      expect(hasPermission('org_admin', 'system:reboot' as Permission)).toBe(false);
      expect(hasPermission('org_admin', '' as Permission)).toBe(false);
      expect(hasPermission('workspace_admin', 'fake:perm' as Permission)).toBe(false);
    });

    it('should fail closed (return false) for null or undefined target/permission', () => {
      expect(hasPermission(undefined, 'workspace:read')).toBe(false);
      expect(hasPermission(null, 'workspace:read')).toBe(false);
      expect(hasPermission('viewer', undefined as unknown as Permission)).toBe(false);
      expect(hasPermission('viewer', null as unknown as Permission)).toBe(false);
    });
  });

  // =========================================================================
  // 6. @RequirePermissions DECORATOR
  // =========================================================================
  describe('@RequirePermissions Decorator', () => {
    it('should attach single permission metadata to method handlers', () => {
      class TestController {
        @RequirePermissions('document:read')
        getDocument() {}
      }

      const reflector = new Reflector();
      const metadata = reflector.get<Permission[]>(PERMISSIONS_KEY, TestController.prototype.getDocument);
      expect(metadata).toEqual(['document:read']);
    });

    it('should attach multiple permissions metadata to method handlers preserving order', () => {
      class TestController {
        @RequirePermissions('document:read', 'document:upload')
        uploadDocument() {}
      }

      const reflector = new Reflector();
      const metadata = reflector.get<Permission[]>(PERMISSIONS_KEY, TestController.prototype.uploadDocument);
      expect(metadata).toEqual(['document:read', 'document:upload']);
    });

    it('should attach permission metadata to controller classes', () => {
      @RequirePermissions('workspace:read')
      class TestController {}

      const reflector = new Reflector();
      const metadata = reflector.get<Permission[]>(PERMISSIONS_KEY, TestController);
      expect(metadata).toEqual(['workspace:read']);
    });

    it('should only store metadata and not execute authorization or throw exceptions at decoration time', () => {
      expect(() => {
        class SafeController {
          @RequirePermissions('audit:read', 'memory:write_shared')
          safeMethod() {
            return 'success';
          }
        }
        const instance = new SafeController();
        expect(instance.safeMethod()).toBe('success');
      }).not.toThrow();
    });
  });
});

import { SetMetadata, CustomDecorator } from '@nestjs/common';
import type { Permission } from '../interfaces/permissions.interface.js';

export const PERMISSIONS_KEY = 'permissions';
export const REQUIRE_PERMISSIONS_KEY = PERMISSIONS_KEY;

/**
 * Declarative route decorator to declare required atomic capability permissions.
 *
 * Usage:
 * ```typescript
 * @RequirePermissions('document:read', 'document:upload')
 * ```
 *
 * Security Invariant: This decorator only attaches metadata to the route handler.
 * Enforcement is performed exclusively by PermissionsGuard.
 */
export const RequirePermissions = (...permissions: Permission[]): CustomDecorator<string> =>
  SetMetadata(PERMISSIONS_KEY, permissions);

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator.js';
import {
  type Permission,
  type PermissionsMap,
  hasPermission,
} from '../interfaces/permissions.interface.js';
import { getRequestContext } from '../../core/supabase/symbols.js';

/**
 * Layer 3 Application RBAC Guard: Granular capability enforcement.
 *
 * Responsibilities:
 * 1. Read required permissions metadata via Reflector.
 * 2. Validate caller authentication status (fails with 401 if unauthenticated).
 * 3. Evaluate caller's effective permissions against all required capabilities.
 * 4. Deny with 403 Forbidden if any required permission is missing or role is unknown.
 *
 * Security Invariants:
 * - Does NOT trust client-supplied headers, query, or body parameters.
 * - Does NOT perform role hierarchy / numeric ordinal comparisons.
 * - Fails closed on missing context, unknown roles, or malformed metadata.
 * - Preserves distinction: 401 for unauthenticated vs 403 for unauthorized.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (!request) {
      throw new UnauthorizedException('Authentication required');
    }

    // 1. Validate authentication context first (fails with 401 if unauthenticated)
    const requestContext = getRequestContext(request);
    if (!requestContext || !requestContext.principal || !requestContext.principal.userId) {
      throw new UnauthorizedException('Authentication required');
    }

    // 2. Obtain required permissions from route metadata (handler or controller class)
    const requiredPermissions = this.reflector.getAllAndOverride<Permission[] | undefined>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // If no permission metadata is set, authenticated route does not require specific capability enforcement
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    // Fail closed if metadata is malformed (not an array)
    if (!Array.isArray(requiredPermissions)) {
      throw new ForbiddenException('Forbidden: Malformed authorization metadata');
    }

    // 3. Obtain caller's effective permissions from validated tenant scope
    const effectivePermissions: PermissionsMap | undefined =
      requestContext.tenantScope?.permissions;

    if (!effectivePermissions) {
      throw new ForbiddenException('Forbidden: Insufficient permissions (no active workspace tenant scope)');
    }

    // 4. Verify that ALL required permissions are satisfied (fail closed)
    for (const requiredPermission of requiredPermissions) {
      if (typeof requiredPermission !== 'string') {
        throw new ForbiddenException('Forbidden: Malformed permission requirement');
      }

      if (!hasPermission(effectivePermissions, requiredPermission)) {
        throw new ForbiddenException(`Forbidden: Missing required capability [${requiredPermission}]`);
      }
    }

    return true;
  }
}

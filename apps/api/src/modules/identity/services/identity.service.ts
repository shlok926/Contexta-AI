import { Injectable, UnauthorizedException, Optional, Inject } from '@nestjs/common';
import { ModuleRef, ContextIdFactory } from '@nestjs/core';
import type { RequestExecutionContext } from '../../core/interfaces/request-execution-context.interface.js';
import { SupabaseService } from '../../core/supabase/supabase.service.js';

export interface UserProfile {
  userId: string;
  email: string;
  organizationId: string;
  isActive: boolean;
}

/**
 * Provider interface for querying authoritative user identity state.
 */
export interface UserLookupProvider {
  findUserById(userId: string): Promise<UserProfile | null>;
}

export const USER_LOOKUP_PROVIDER: unique symbol = Symbol('USER_LOOKUP_PROVIDER');

/**
 * Singleton service responsible for validating user active status against authoritative database state.
 *
 * Security Invariant: Method signatures MUST NOT accept raw bearer tokens or authorization headers.
 * Resolves request-scoped SupabaseService via NestJS ModuleRef + ContextIdFactory.
 */
@Injectable()
export class IdentityService {
  private readonly userLookupProvider?: UserLookupProvider;
  private readonly moduleRef?: ModuleRef;

  constructor(
    @Optional()
    @Inject(ModuleRef)
    moduleRef?: ModuleRef | UserLookupProvider,
    @Optional()
    @Inject(USER_LOOKUP_PROVIDER)
    userLookupProvider?: UserLookupProvider,
  ) {
    if (moduleRef && typeof (moduleRef as unknown as UserLookupProvider).findUserById === 'function') {
      this.userLookupProvider = moduleRef as unknown as UserLookupProvider;
      this.moduleRef = undefined;
    } else {
      this.moduleRef = moduleRef as ModuleRef | undefined;
      this.userLookupProvider = userLookupProvider;
    }
  }

  async validateActiveUser(
    userId: string,
    context?: RequestExecutionContext,
  ): Promise<UserProfile> {
    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      throw new UnauthorizedException('Authentication failed: Missing or invalid user ID');
    }

    // 1. Explicit user lookup provider (for unit testing / custom overrides)
    if (this.userLookupProvider) {
      const profile = await this.userLookupProvider.findUserById(userId);
      if (!profile) {
        throw new UnauthorizedException('Authentication failed: User account not found');
      }
      if (!profile.isActive) {
        throw new UnauthorizedException('Authentication failed: User account is inactive');
      }
      if (!profile.organizationId) {
        throw new UnauthorizedException('Authentication failed: User record has no organization');
      }
      return profile;
    }

    // 2. Production path: resolve request-scoped SupabaseService via ModuleRef + ContextIdFactory
    if (context?.rawRequest && this.moduleRef) {
      const contextId = ContextIdFactory.getByRequest(context.rawRequest);
      this.moduleRef.registerRequestByContextId(context.rawRequest, contextId);
      const supabaseService = await this.moduleRef.resolve(SupabaseService, contextId, { strict: false });
      if (!supabaseService) {
        throw new UnauthorizedException('Authentication failed: Supabase infrastructure service unavailable');
      }

      const client = supabaseService.getClient();
      const { data, error } = await client
        .from('users')
        .select('id, organization_id, email, is_active')
        .eq('id', userId)
        .single();

      if (error || !data) {
        throw new UnauthorizedException('Authentication failed: User account not found');
      }

      if (!data.is_active) {
        throw new UnauthorizedException('Authentication failed: User account is inactive');
      }

      if (!data.organization_id) {
        throw new UnauthorizedException('Authentication failed: User record has no organization');
      }

      return {
        userId: data.id,
        email: data.email ?? '',
        organizationId: data.organization_id,
        isActive: data.is_active,
      };
    }

    // Default fail-closed fallback if neither provider nor execution context is configured
    throw new UnauthorizedException('Authentication failed: User lookup provider not configured');
  }
}

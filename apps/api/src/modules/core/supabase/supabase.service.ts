import { Injectable, Scope, Inject, UnauthorizedException } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getVerifiedToken } from './symbols.js';
import type { AuthConfig } from '../config/auth-config.schema.js';

// Ensure WebSocket constructor exists in headless Node.js environments
if (typeof (globalThis as any).WebSocket === 'undefined') {
  (globalThis as any).WebSocket = class MockWebSocket {};
}

/**
 * Request-scoped Supabase client provider (Scope.REQUEST).
 *
 * Responsibilities:
 * 1. Instantiated per incoming HTTP request.
 * 2. Extracts the cryptographically verified JWT bearer token strictly from req[REQUEST_TOKEN_SYMBOL].
 * 3. Never inspects raw Authorization headers or caller parameters directly.
 * 4. Constructs an authenticated Supabase PostgREST client using SUPABASE_URL, SUPABASE_ANON_KEY, and the user's bearer token.
 * 5. Guarantees zero usage of SUPABASE_SERVICE_ROLE_KEY and zero token leakage across requests.
 */
@Injectable({ scope: Scope.REQUEST })
export class SupabaseService {
  private readonly client: SupabaseClient;

  constructor(
    @Inject(REQUEST)
    private readonly request: Request,
    private readonly configService: ConfigService<AuthConfig>,
  ) {
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
    const supabaseAnonKey = this.configService.get<string>('SUPABASE_ANON_KEY');

    if (!supabaseUrl || !supabaseAnonKey) {
      throw new UnauthorizedException('Authentication failed: Missing Supabase configuration');
    }

    const token = getVerifiedToken(this.request);
    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      throw new UnauthorizedException('Authentication failed: Missing verified request token');
    }

    this.client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });
  }

  /**
   * Returns the authenticated user-scoped Supabase client bound to this request's verified JWT.
   */
  getClient(): SupabaseClient {
    return this.client;
  }
}

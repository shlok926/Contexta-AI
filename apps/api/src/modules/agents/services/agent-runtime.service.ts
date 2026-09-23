import {
  Injectable,
  InternalServerErrorException,
  Optional,
  Inject,
} from '@nestjs/common';
import { ModuleRef, ContextIdFactory } from '@nestjs/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseService } from '../../core/supabase/supabase.service.js';
import type { RequestExecutionContext } from '../../core/interfaces/request-execution-context.interface.js';
import type { RequestContext } from '../../identity/interfaces/request-context.interface.js';
import {
  type ExecutionContext,
  type CreateExecutionContextParams,
  type TraceMetadata,
  createExecutionContext,
} from '../interfaces/execution-context.interface.js';
import {
  type AgentRunnableConfig,
  type CreateAgentRunnableConfigOptions,
  type RunnableConfigLike,
  createAgentRunnableConfig,
  extractExecutionContext,
} from '../adapters/runnable-config.bridge.js';
import {
  type IngestRequestContextInput,
  type IngestedProtectedContext,
} from '../interfaces/context-ingestion.interface.js';
import {
  ingestRequestContext,
  createInitialAgentStateFromRequestContext,
} from '../adapters/context-ingestion.adapter.js';
import type { AgentState } from '../../../../../../packages/agents/src/state.js';

export interface ResolveExecutionContextOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly traceMetadata?: TraceMetadata;
}

/**
 * AgentRuntimeService is the foundation service for the Contexta-AI Agent Runtime.
 *
 * Invariants:
 * 1. STATELESS SINGLETON: Holds zero request-specific state, per-request cache, or global state.
 * 2. DI-RESOLVED CLIENT: Resolves request-scoped Supabase client via NestJS DI (ModuleRef / SupabaseService).
 * 3. RUNTIME BOUNDARY: Constructs ExecutionContext, LangChain RunnableConfig bridges, and protected AgentState.
 * 4. CONCURRENCY-SAFE: Multiple concurrent invocations execute in complete isolation without cross-contamination.
 */
@Injectable()
export class AgentRuntimeService {
  constructor(
    @Optional()
    @Inject(ModuleRef)
    private readonly moduleRef?: ModuleRef,
    @Optional()
    @Inject(SupabaseService)
    private readonly supabaseService?: SupabaseService,
  ) {}

  /**
   * Ingests an authenticated N2 RequestContext to extract an immutable, protected context tuple.
   */
  ingestRequestContext(
    requestContext: RequestContext,
    input: IngestRequestContextInput
  ): IngestedProtectedContext {
    return ingestRequestContext(requestContext, input);
  }

  /**
   * Constructs a fully initialized, canonical AgentState from an authenticated RequestContext
   * and input parameters, strictly quarantined from credentials and infrastructure handles.
   */
  createInitialState(
    requestContext: RequestContext,
    input: IngestRequestContextInput
  ): AgentState {
    return createInitialAgentStateFromRequestContext(requestContext, input);
  }

  /**
   * Resolves the request-scoped Supabase client from a RequestExecutionContext
   * and constructs a typed ExecutionContext.
   */
  async resolveExecutionContext(
    reqExecContext: RequestExecutionContext,
    options?: ResolveExecutionContextOptions,
  ): Promise<ExecutionContext> {
    const supabaseClient = await this.getScopedSupabaseClient(reqExecContext);

    return createExecutionContext({
      supabaseClient,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
      traceMetadata: options?.traceMetadata,
    });
  }

  /**
   * Constructs an ExecutionContext directly from an existing SupabaseClient instance.
   */
  createExecutionContext(params: CreateExecutionContextParams): ExecutionContext {
    return createExecutionContext(params);
  }

  /**
   * Bridges an ExecutionContext into a typed LangChain RunnableConfig.
   */
  createRunnableConfig(
    context: ExecutionContext,
    options?: CreateAgentRunnableConfigOptions,
  ): AgentRunnableConfig {
    return createAgentRunnableConfig(context, options);
  }

  /**
   * Extracts an ExecutionContext from a LangChain RunnableConfig if present.
   */
  extractExecutionContext(
    config?: RunnableConfigLike,
  ): ExecutionContext | undefined {
    return extractExecutionContext(config);
  }

  /**
   * Resolves the request-scoped Supabase client instance using NestJS ContextId.
   */
  private async getScopedSupabaseClient(
    execContext: RequestExecutionContext,
  ): Promise<SupabaseClient> {
    if (this.supabaseService) {
      return this.supabaseService.getClient();
    }

    if (this.moduleRef) {
      const request = execContext.rawRequest;
      const contextId = ContextIdFactory.getByRequest(request);
      this.moduleRef.registerRequestByContextId(request, contextId);
      const scopedSupabase = await this.moduleRef.resolve(SupabaseService, contextId, { strict: false });
      if (!scopedSupabase) {
        throw new InternalServerErrorException('Database infrastructure unavailable for agent runtime');
      }
      return scopedSupabase.getClient();
    }

    throw new InternalServerErrorException('Agent runtime DI resolution failed: Missing Supabase provider');
  }
}

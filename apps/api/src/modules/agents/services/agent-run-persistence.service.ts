import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Optional,
  Inject,
} from '@nestjs/common';
import { ModuleRef, ContextIdFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseService } from '../../core/supabase/supabase.service.js';
import type { RequestExecutionContext } from '../../core/interfaces/request-execution-context.interface.js';
import type { RequestContext } from '../../identity/interfaces/request-context.interface.js';
import {
  type RunStatus,
  type CreateRunParams,
  type CreateRunResult,
  type AgentRunEntity,
  type RecordStepParams,
  type AgentRunStepEntity,
  type FinalizeRunParams,
  type StepTelemetryProjection,
  RUN_STATUSES,
  StepTelemetryProjectionSchema,
} from '../interfaces/run-persistence.interface.js';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const VALID_LIFECYCLE_TRANSITIONS: Readonly<Record<RunStatus, ReadonlySet<RunStatus>>> = Object.freeze({
  accepted: new Set<RunStatus>(['running', 'failed', 'cancelled']),
  running: new Set<RunStatus>(['completed', 'declined_uncertain', 'failed', 'cancelled']),
  completed: new Set<RunStatus>(),
  declined_uncertain: new Set<RunStatus>(),
  failed: new Set<RunStatus>(),
  cancelled: new Set<RunStatus>(),
});

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'completed',
  'declined_uncertain',
  'failed',
  'cancelled',
]);

interface DbAgentRunRow {
  id: string;
  workspace_id: string;
  thread_id: string;
  initiating_message_id: string;
  assistant_message_id: string | null;
  user_id: string;
  correlation_id: string;
  query: string;
  status: RunStatus;
  verification_confidence_score: number | null;
  started_at: string;
  completed_at: string | null;
}

interface DbAgentRunStepRow {
  id: string;
  agent_run_id: string;
  workspace_id: string;
  agent_name: string;
  node_name: string;
  input_payload: Record<string, unknown>;
  output_payload: Record<string, unknown>;
  duration_ms: number;
  executed_at: string;
}

/**
 * AgentRunPersistenceService
 *
 * Authoritative persistence boundary for agent runs, conversational turn submissions,
 * lifecycle state transitions, and granular node execution audit traces in Contexta-AI (ADR-0006, ADR-0007).
 *
 * Architectural & Security Invariants:
 * 1. DATABASE-OWNED ATOMICITY: Turn creation and terminal response commitment are executed
 *    as single atomic transactions via PostgreSQL RPCs (create_agent_run_turn, commit_agent_run_response).
 *    Zero reliance on application-level compensating deletes.
 * 2. HARD RUN IDENTITY RULE: runId === agent_runs.id. There is no separate executionId.
 * 3. DATABASE CONCURRENCY SAFETY: Lifecycle transitions and terminal completions use PostgreSQL row locking (FOR UPDATE)
 *    and conditional update semantics. Concurrent conflicting transitions deterministically fail with ConflictException.
 * 4. APPEND-ONLY STEP AUDITING: agent_run_steps is strictly an append-oriented audit log. No update/delete mutations.
 * 5. TENANT ISOLATION & RLS: All operations execute through the request-scoped Supabase client under the caller's JWT.
 *    Zero service_role bypass or raw bearer tokens accepted.
 * 6. TELEMETRY QUARANTINE: Step payloads are sanitized strictly against StepTelemetryProjectionSchema.
 *    Prompts, model completions, credentials, and chain-of-thought are strictly forbidden/stripped.
 */
@Injectable()
export class AgentRunPersistenceService {
  constructor(
    @Optional()
    @Inject(ModuleRef)
    private readonly moduleRef?: ModuleRef,
    @Optional()
    @Inject(SupabaseService)
    private readonly supabaseService?: SupabaseService,
  ) {}

  /**
   * Resolves the request-scoped Supabase client.
   */
  private async getClient(execContext?: RequestExecutionContext): Promise<SupabaseClient> {
    if (this.supabaseService) {
      return this.supabaseService.getClient();
    }

    if (this.moduleRef && execContext) {
      const request = execContext.rawRequest;
      const contextId = ContextIdFactory.getByRequest(request);
      this.moduleRef.registerRequestByContextId(request, contextId);
      const scopedSupabase = await this.moduleRef.resolve(SupabaseService, contextId, { strict: false });
      if (!scopedSupabase) {
        throw new InternalServerErrorException('Database infrastructure unavailable');
      }
      return scopedSupabase.getClient();
    }

    throw new InternalServerErrorException('Supabase client provider not configured for agent persistence');
  }

  /**
   * Atomically creates an initiating user message and an agent_runs record in the accepted state
   * within a single database transaction via create_agent_run_turn RPC.
   */
  async createRun(
    requestContext: RequestContext,
    params: CreateRunParams,
    execContext?: RequestExecutionContext,
  ): Promise<CreateRunResult> {
    this.validateRequestContext(requestContext);

    const threadId = params.threadId?.trim();
    if (!threadId || !UUID_V4_REGEX.test(threadId)) {
      throw new BadRequestException('Invalid threadId: Must be a valid UUIDv4 string');
    }

    const query = params.query?.trim();
    if (!query || query.length === 0) {
      throw new BadRequestException('Invalid query: Query must not be empty');
    }

    let runId = params.runId?.trim();
    if (runId) {
      if (!UUID_V4_REGEX.test(runId)) {
        throw new BadRequestException('Invalid runId: When provided, runId must be a valid UUIDv4 string');
      }
    } else {
      runId = randomUUID();
    }

    const client = await this.getClient(execContext);
    const correlationId = requestContext.metadata.correlationId;

    // Execute atomic turn creation in a single database transaction
    const { data, error } = await client.rpc('create_agent_run_turn', {
      p_thread_id: threadId,
      p_query: query,
      p_run_id: runId,
      p_correlation_id: correlationId,
    });

    if (error) {
      this.handlePostgrestError(error, 'Failed to create agent run turn');
    }

    const row = Array.isArray(data) ? (data[0] as DbAgentRunRow) : (data as DbAgentRunRow);
    if (!row) {
      throw new InternalServerErrorException('Failed to create agent run: No record returned from database');
    }

    const entity = this.mapDbRowToEntity(row);
    return {
      run: entity,
      initiatingMessageId: entity.initiatingMessageId,
    };
  }

  /**
   * Atomically transitions an agent run from fromStatus to toStatus deterministically
   * via transition_agent_run_status RPC with row locking (FOR UPDATE).
   */
  async transitionRunStatus(
    requestContext: RequestContext,
    runId: string,
    fromStatus: RunStatus,
    toStatus: RunStatus,
    execContext?: RequestExecutionContext,
  ): Promise<AgentRunEntity> {
    this.validateRequestContext(requestContext);

    if (!runId || !UUID_V4_REGEX.test(runId)) {
      throw new BadRequestException('Invalid runId: Must be a valid UUIDv4 string');
    }

    if (!RUN_STATUSES.includes(fromStatus) || !RUN_STATUSES.includes(toStatus)) {
      throw new BadRequestException(`Invalid status values: from=${fromStatus}, to=${toStatus}`);
    }

    const allowedTargets = VALID_LIFECYCLE_TRANSITIONS[fromStatus];
    if (!allowedTargets || !allowedTargets.has(toStatus)) {
      throw new ConflictException(
        `Invalid run lifecycle transition: Cannot transition from '${fromStatus}' to '${toStatus}'`,
      );
    }

    const client = await this.getClient(execContext);

    const { data, error } = await client.rpc('transition_agent_run_status', {
      p_run_id: runId,
      p_from_status: fromStatus,
      p_to_status: toStatus,
    });

    if (error) {
      this.handlePostgrestError(error, `Failed to transition run ${runId}`);
    }

    const row = Array.isArray(data) ? (data[0] as DbAgentRunRow) : (data as DbAgentRunRow);
    if (!row) {
      throw new InternalServerErrorException(`Run ${runId} update failed unexpectedly`);
    }

    return this.mapDbRowToEntity(row);
  }

  /**
   * Persists a granular node execution step into agent_run_steps (append-only audit trace).
   * Payloads are strictly sanitized against the StepTelemetryProjection allowlist schema.
   */
  async recordStep(
    requestContext: RequestContext,
    params: RecordStepParams,
    execContext?: RequestExecutionContext,
  ): Promise<AgentRunStepEntity> {
    this.validateRequestContext(requestContext);

    const runId = params.runId?.trim();
    if (!runId || !UUID_V4_REGEX.test(runId)) {
      throw new BadRequestException('Invalid runId: Must be a valid UUIDv4 string');
    }

    const agentName = params.agentName?.trim();
    if (!agentName || agentName.length === 0 || agentName.length > 50) {
      throw new BadRequestException('Invalid agentName: Must be non-empty and maximum 50 characters');
    }

    const nodeName = params.nodeName?.trim();
    if (!nodeName || nodeName.length === 0 || nodeName.length > 50) {
      throw new BadRequestException('Invalid nodeName: Must be non-empty and maximum 50 characters');
    }

    if (typeof params.durationMs !== 'number' || !Number.isInteger(params.durationMs) || params.durationMs < 0) {
      throw new BadRequestException('Invalid durationMs: Must be a non-negative integer');
    }

    const sanitizedInput = this.sanitizeTelemetryPayload(params.inputPayload);
    const sanitizedOutput = this.sanitizeTelemetryPayload(params.outputPayload);

    const client = await this.getClient(execContext);
    const workspaceId = requestContext.tenantScope.workspaceId;
    const stepId = randomUUID();

    const { data: stepData, error } = await client
      .from('agent_run_steps')
      .insert({
        id: stepId,
        agent_run_id: runId,
        workspace_id: workspaceId,
        agent_name: agentName,
        node_name: nodeName,
        input_payload: sanitizedInput,
        output_payload: sanitizedOutput,
        duration_ms: params.durationMs,
        executed_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      this.handlePostgrestError(error, `Failed to record step for run ${runId}`);
    }

    if (!stepData) {
      throw new InternalServerErrorException('Failed to persist agent run step: No data returned');
    }

    return this.mapDbStepRowToEntity(stepData as DbAgentRunStepRow);
  }

  /**
   * Finalizes a run into a terminal state within a single database transaction via commit_agent_run_response RPC.
   *
   * Invariants:
   * - completed / declined_uncertain: conditionally creates assistant message if content provided.
   * - failed / cancelled: NEVER creates an assistant message.
   * - Row-locking prevents concurrent terminal collision.
   */
  async finalizeRun(
    requestContext: RequestContext,
    params: FinalizeRunParams,
    execContext?: RequestExecutionContext,
  ): Promise<AgentRunEntity> {
    this.validateRequestContext(requestContext);

    const runId = params.runId?.trim();
    if (!runId || !UUID_V4_REGEX.test(runId)) {
      throw new BadRequestException('Invalid runId: Must be a valid UUIDv4 string');
    }

    if (!TERMINAL_STATUSES.has(params.status)) {
      throw new BadRequestException(
        `Invalid terminal status: '${params.status}'. Must be one of: completed, declined_uncertain, failed, cancelled`,
      );
    }

    if (params.status === 'failed' || params.status === 'cancelled') {
      if (params.assistantMessage) {
        throw new BadRequestException(
          `Invariant violation: Assistant message cannot be persisted for run status '${params.status}'`,
        );
      }
    }

    let assistantContent: string | null = null;
    let citations: unknown[] = [];

    if (params.assistantMessage) {
      const content = params.assistantMessage.content?.trim();
      if (!content || content.length === 0) {
        throw new BadRequestException('Assistant message content must not be empty');
      }
      assistantContent = content;
      citations = params.assistantMessage.citations ?? [];
    }

    if (params.verificationConfidenceScore !== undefined && params.verificationConfidenceScore !== null) {
      if (
        typeof params.verificationConfidenceScore !== 'number' ||
        params.verificationConfidenceScore < 0 ||
        params.verificationConfidenceScore > 1
      ) {
        throw new BadRequestException('verificationConfidenceScore must be a number between 0.0 and 1.0 or null');
      }
    }

    const client = await this.getClient(execContext);

    const { data, error } = await client.rpc('commit_agent_run_response', {
      p_run_id: runId,
      p_status: params.status,
      p_assistant_content: assistantContent,
      p_citations: citations,
      p_verification_score: params.verificationConfidenceScore ?? null,
    });

    if (error) {
      this.handlePostgrestError(error, `Failed to finalize run ${runId}`);
    }

    const row = Array.isArray(data) ? (data[0] as DbAgentRunRow) : (data as DbAgentRunRow);
    if (!row) {
      throw new InternalServerErrorException('Failed to finalize run: No record returned from database');
    }

    return this.mapDbRowToEntity(row);
  }

  /**
   * Retrieves an agent run by ID within the caller's authorized workspace.
   */
  async getRun(
    requestContext: RequestContext,
    runId: string,
    execContext?: RequestExecutionContext,
  ): Promise<AgentRunEntity> {
    this.validateRequestContext(requestContext);

    if (!runId || !UUID_V4_REGEX.test(runId)) {
      throw new BadRequestException('Invalid runId: Must be a valid UUIDv4 string');
    }

    const client = await this.getClient(execContext);
    const workspaceId = requestContext.tenantScope.workspaceId;

    const { data, error } = await client
      .from('agent_runs')
      .select('*')
      .eq('id', runId)
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    if (error) {
      this.handlePostgrestError(error, `Failed to query run ${runId}`);
    }

    if (!data) {
      throw new NotFoundException(`Agent run ${runId} not found`);
    }

    return this.mapDbRowToEntity(data as DbAgentRunRow);
  }

  /**
   * Retrieves all granular execution steps for a run ordered chronologically (executed_at ASC).
   */
  async getRunSteps(
    requestContext: RequestContext,
    runId: string,
    execContext?: RequestExecutionContext,
  ): Promise<AgentRunStepEntity[]> {
    this.validateRequestContext(requestContext);

    if (!runId || !UUID_V4_REGEX.test(runId)) {
      throw new BadRequestException('Invalid runId: Must be a valid UUIDv4 string');
    }

    const client = await this.getClient(execContext);
    const workspaceId = requestContext.tenantScope.workspaceId;

    const { data, error } = await client
      .from('agent_run_steps')
      .select('*')
      .eq('agent_run_id', runId)
      .eq('workspace_id', workspaceId)
      .order('executed_at', { ascending: true });

    if (error) {
      this.handlePostgrestError(error, `Failed to query steps for run ${runId}`);
    }

    if (!data) {
      return [];
    }

    return (data as DbAgentRunStepRow[]).map((row) => this.mapDbStepRowToEntity(row));
  }

  /**
   * Validates that the RequestContext contains authorized tenant scope.
   */
  private validateRequestContext(requestContext: RequestContext): void {
    if (!requestContext?.principal?.userId) {
      throw new ForbiddenException('Unauthenticated: Missing valid principal user ID');
    }
    if (!requestContext?.tenantScope?.workspaceId) {
      throw new ForbiddenException('Forbidden: RequestContext missing authorized tenant workspace scope');
    }
  }

  /**
   * Sanitizes payload against StepTelemetryProjectionSchema to strictly quarantine prohibited fields.
   */
  private sanitizeTelemetryPayload(payload?: StepTelemetryProjection | Record<string, unknown>): Record<string, unknown> {
    if (!payload || Object.keys(payload).length === 0) {
      return {};
    }

    const parseResult = StepTelemetryProjectionSchema.safeParse(payload);
    if (!parseResult.success) {
      const sanitized: Record<string, unknown> = {};
      const allowedKeys: (keyof StepTelemetryProjection)[] = [
        'nodeName',
        'status',
        'durationMs',
        'errorCategory',
        'routeDecision',
        'evidenceCount',
        'claimCount',
        'verifiedClaimCount',
        'verificationScore',
      ];

      for (const key of allowedKeys) {
        if (key in payload && (payload as Record<string, unknown>)[key] !== undefined) {
          sanitized[key] = (payload as Record<string, unknown>)[key];
        }
      }
      return sanitized;
    }

    return parseResult.data as unknown as Record<string, unknown>;
  }

  /**
   * Maps a raw database row from agent_runs to a typed AgentRunEntity.
   */
  private mapDbRowToEntity(row: DbAgentRunRow): AgentRunEntity {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      threadId: row.thread_id,
      initiatingMessageId: row.initiating_message_id,
      assistantMessageId: row.assistant_message_id,
      userId: row.user_id,
      correlationId: row.correlation_id,
      query: row.query,
      status: row.status,
      verificationConfidenceScore: row.verification_confidence_score,
      startedAt: new Date(row.started_at),
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
    };
  }

  /**
   * Maps a raw database row from agent_run_steps to a typed AgentRunStepEntity.
   */
  private mapDbStepRowToEntity(row: DbAgentRunStepRow): AgentRunStepEntity {
    return {
      id: row.id,
      agentRunId: row.agent_run_id,
      workspaceId: row.workspace_id,
      agentName: row.agent_name,
      nodeName: row.node_name,
      inputPayload: row.input_payload ?? {},
      outputPayload: row.output_payload ?? {},
      durationMs: row.duration_ms,
      executedAt: new Date(row.executed_at),
    };
  }

  /**
   * Normalizes PostgREST error codes to standard NestJS RFC 7807 exceptions.
   */
  private handlePostgrestError(error: { code?: string; message?: string }, defaultMessage: string): never {
    const code = error.code;
    const msg = error.message || '';

    if (code === '42501' || msg.includes('FORBIDDEN') || msg.includes('UNAUTHENTICATED')) {
      throw new ForbiddenException(msg || 'Forbidden: Insufficient privileges under active RLS policy');
    }
    if (code === 'P0001' || code === '23505' || msg.includes('CONFLICT')) {
      throw new ConflictException(msg || 'Resource conflict or concurrent state mismatch');
    }
    if (code === '23503') {
      throw new BadRequestException(msg || 'Foreign key violation: Referenced entity does not exist');
    }
    if (code === '22023' || code === '22P02' || msg.includes('INVALID_PARAMETER') || msg.includes('INVALID_TRANSITION') || msg.includes('INVARIANT_VIOLATION')) {
      throw new BadRequestException(msg || 'Invalid input parameter or syntax');
    }
    throw new InternalServerErrorException(`${defaultMessage}: ${msg || 'Unknown database error'}`);
  }
}

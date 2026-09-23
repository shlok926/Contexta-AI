import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  Optional,
  Inject,
} from '@nestjs/common';
import { SupabaseService } from '../../core/supabase/supabase.service.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RequestContext } from '../../identity/interfaces/request-context.interface.js';
import type { RequestExecutionContext } from '../../core/interfaces/request-execution-context.interface.js';
import {
  type ExecutionContext,
} from '../interfaces/execution-context.interface.js';
import { AgentRuntimeService } from './agent-runtime.service.js';
import { AgentRunPersistenceService } from './agent-run-persistence.service.js';
import { RetrievalOrchestratorService } from './retrieval-orchestrator.service.js';
import { OpenAIDraftGeneratorAdapter } from '../adapters/openai-draft-generator.adapter.js';
import { OpenAIVerificationAdapter } from '../adapters/openai-verification.adapter.js';
import {
  graph,
  type AgentState,
  type VerificationResult,
  type IDraftGeneratorProvider,
  type IVerificationProvider,
  type ResearchNodeOptions,
  type SupervisorNodeOptions,
} from '../../../../../../packages/agents/src/index.js';
import type { CanonicalSseEnvelope, SsePayload } from '../dto/sse-event.dto.js';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ExecuteRunParams {
  readonly threadId: string;
  readonly query: string;
  readonly runId?: string;
  readonly parameters?: Record<string, unknown>;
}

export interface RunOrchestrationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly supabaseClient?: SupabaseClient;
  readonly draftGeneratorProvider?: IDraftGeneratorProvider;
  readonly verificationProvider?: IVerificationProvider;
  readonly researchOptions?: ResearchNodeOptions;
  readonly supervisorOptions?: SupervisorNodeOptions;
}

export interface OrchestratorCitation {
  readonly id: string;
  readonly claimText: string;
  readonly citedChunkIds: readonly string[];
  readonly entailmentScore?: number;
  readonly status: string;
  readonly explanation?: string;
  readonly sourceDocumentId?: string;
  readonly pageNumber?: number;
}

export interface RunsOrchestratorResult {
  readonly runId: string;
  readonly threadId: string;
  readonly workspaceId: string;
  readonly status: 'completed' | 'declined_uncertain' | 'failed' | 'cancelled';
  readonly finalResponse?: string;
  readonly citations?: readonly OrchestratorCitation[];
  readonly verificationScore?: number | null;
  readonly initiatingMessageId?: string;
  readonly assistantMessageId?: string | null;
  readonly startedAt: Date;
  readonly completedAt?: Date | null;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

interface PreparedRunContext {
  readonly runId: string;
  readonly threadId: string;
  readonly workspaceId: string;
  readonly query: string;
  readonly correlationId: string;
  readonly initiatingMessageId: string;
  readonly startedAt: Date;
  readonly initialState: AgentState;
  readonly enhancedConfig: any;
  readonly signal?: AbortSignal;
}

interface MappedTerminalExecutionState {
  readonly targetStatus: 'completed' | 'declined_uncertain' | 'failed' | 'cancelled';
  readonly assistantContent?: string;
  readonly mappedCitations?: OrchestratorCitation[];
  readonly verificationScore: number | null;
  readonly errorDetail?: {
    readonly code: string;
    readonly message: string;
  };
}

/**
 * RunsOrchestratorService (N3.8-C7.2 / N3.8-C7.4)
 *
 * Unified application orchestration service coordinating both REST and SSE executions:
 *   1. RequestContext validation & tenant isolation
 *   2. Atomic turn creation via create_agent_run_turn (AgentRunPersistenceService.createRun)
 *   3. Lifecycle transition: accepted -> running (AgentRunPersistenceService.transitionRunStatus)
 *   4. Credential-free AgentState construction (AgentRuntimeService.createInitialState)
 *   5. LangChain RunnableConfig assembly with ExecutionContext
 *   6. Canonical LangGraph execution:
 *      - REST: graph.invoke
 *      - SSE: graph.stream with strict event allowlist projection
 *   7. Deterministic terminal state mapping (completed vs declined_uncertain vs failed vs cancelled)
 *   8. Atomic response finalization via commit_agent_run_response (AgentRunPersistenceService.finalizeRun)
 *   9. Single-authority database persistence and cancellation concurrency
 */
@Injectable()
export class RunsOrchestratorService {
  constructor(
    private readonly runtimeService: AgentRuntimeService,
    private readonly persistenceService: AgentRunPersistenceService,
    private readonly retrievalOrchestrator: RetrievalOrchestratorService,
    @Optional()
    @Inject(SupabaseService)
    private readonly supabaseService?: SupabaseService,
    @Optional()
    @Inject(OpenAIDraftGeneratorAdapter)
    private readonly defaultDraftProvider?: OpenAIDraftGeneratorAdapter,
    @Optional()
    @Inject(OpenAIVerificationAdapter)
    private readonly defaultVerificationProvider?: OpenAIVerificationAdapter,
  ) {}

  /**
   * Executes a complete agent run synchronously through the authoritative LangGraph state machine.
   */
  async executeRun(
    params: ExecuteRunParams,
    requestContext: RequestContext,
    execContext?: RequestExecutionContext,
    options?: RunOrchestrationOptions,
  ): Promise<RunsOrchestratorResult> {
    const prep = await this.prepareRunContext(params, requestContext, execContext, options);

    let terminalState: AgentState | undefined;
    let executionError: Error | undefined;

    try {
      if (prep.signal?.aborted) {
        throw new Error('Run execution aborted before graph invocation');
      }

      terminalState = (await graph.invoke(prep.initialState, prep.enhancedConfig)) as AgentState;
    } catch (err) {
      executionError = err instanceof Error ? err : new Error(String(err));
    }

    const mapped = this.mapTerminalExecutionState(terminalState, executionError, prep.signal);

    const finalizedRun = await this.persistenceService.finalizeRun(
      requestContext,
      {
        runId: prep.runId,
        status: mapped.targetStatus,
        assistantMessage: mapped.assistantContent
          ? {
              content: mapped.assistantContent,
              citations:
                mapped.mappedCitations && mapped.mappedCitations.length > 0
                  ? (mapped.mappedCitations as any[])
                  : undefined,
            }
          : undefined,
        verificationConfidenceScore: mapped.verificationScore,
      },
      execContext,
    );

    return {
      runId: finalizedRun.id,
      threadId: finalizedRun.threadId,
      workspaceId: finalizedRun.workspaceId,
      status: mapped.targetStatus,
      finalResponse: mapped.assistantContent,
      citations: mapped.mappedCitations,
      verificationScore: mapped.verificationScore,
      initiatingMessageId: prep.initiatingMessageId,
      assistantMessageId: finalizedRun.assistantMessageId,
      startedAt: prep.startedAt,
      completedAt: finalizedRun.completedAt,
      error: mapped.errorDetail,
    };
  }

  /**
   * Executes an agent run over an incremental Server-Sent Events (SSE) stream.
   * Emits strictly allowlisted CanonicalSseEnvelope events while sharing 100% of
   * the canonical turn creation, execution context, and persistence lifecycle.
   */
  async *executeStreamRun(
    params: ExecuteRunParams,
    requestContext: RequestContext,
    execContext?: RequestExecutionContext,
    options?: RunOrchestrationOptions,
  ): AsyncGenerator<CanonicalSseEnvelope<SsePayload>, void, unknown> {
    const prep = await this.prepareRunContext(params, requestContext, execContext, options);
    let sequence = 1;

    // 1. Emit 'run_started'
    yield this.createEnvelope('run_started', prep, sequence++, {
      run_id: prep.runId,
      thread_id: prep.threadId,
      workspace_id: prep.workspaceId,
    });

    let accumulatedState: AgentState = { ...prep.initialState };
    let executionError: Error | undefined;

    try {
      if (prep.signal?.aborted) {
        throw new Error('Run execution aborted before graph stream');
      }

      const streamIterator = await graph.stream(prep.initialState, prep.enhancedConfig);

      for await (const chunk of streamIterator) {
        if (prep.signal?.aborted) {
          throw new Error('Run execution aborted during graph stream');
        }

        // Project step events from each node delta
        for (const [nodeName, nodeDelta] of Object.entries(chunk)) {
          accumulatedState = { ...accumulatedState, ...(nodeDelta as Partial<AgentState>) };
          const projectedEvents = this.projectNodeStepEvents(
            nodeName,
            nodeDelta as Partial<AgentState>,
            prep,
            () => sequence++,
          );
          for (const env of projectedEvents) {
            yield env;
          }
        }
      }
    } catch (err) {
      executionError = err instanceof Error ? err : new Error(String(err));
    }

    // 2. Single-Authority Terminal Mapping
    const mapped = this.mapTerminalExecutionState(accumulatedState, executionError, prep.signal);

    // 3. Single-Authority Database Finalization (commit_agent_run_response)
    const finalizedRun = await this.persistenceService.finalizeRun(
      requestContext,
      {
        runId: prep.runId,
        status: mapped.targetStatus,
        assistantMessage: mapped.assistantContent
          ? {
              content: mapped.assistantContent,
              citations:
                mapped.mappedCitations && mapped.mappedCitations.length > 0
                  ? (mapped.mappedCitations as any[])
                  : undefined,
            }
          : undefined,
        verificationConfidenceScore: mapped.verificationScore,
      },
      execContext,
    );

    // 4. Emit Terminal SSE Event
    if (mapped.targetStatus === 'completed' || mapped.targetStatus === 'declined_uncertain') {
      yield this.createEnvelope('done', prep, sequence++, {
        run_id: prep.runId,
        duration_ms: Date.now() - prep.startedAt.getTime(),
        completed_at: finalizedRun.completedAt
          ? finalizedRun.completedAt.toISOString()
          : new Date().toISOString(),
      });
    } else {
      yield this.createEnvelope('error', prep, sequence++, {
        code: mapped.errorDetail?.code || 'EXECUTION_FAILED',
        message: mapped.errorDetail?.message || 'Agent run execution failed',
      });
    }
  }

  /**
   * Prepares the common execution context: Ingress validation, atomic run creation,
   * lifecycle transition to running, AgentState initialization, and RunnableConfig assembly.
   */
  private async prepareRunContext(
    params: ExecuteRunParams,
    requestContext: RequestContext,
    execContext?: RequestExecutionContext,
    options?: RunOrchestrationOptions,
  ): Promise<PreparedRunContext> {
    this.validateIngress(params, requestContext);

    const threadId = params.threadId.trim();
    const query = params.query.trim();
    const workspaceId = requestContext.tenantScope!.workspaceId;
    const signal = options?.signal;
    const correlationId =
      requestContext.metadata?.correlationId ||
      `req-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    const createResult = await this.persistenceService.createRun(
      requestContext,
      {
        threadId,
        query,
        runId: params.runId,
      },
      execContext,
    );

    const runId = createResult.run.id;
    const initiatingMessageId = createResult.initiatingMessageId;
    const startedAt = createResult.run.startedAt;

    await this.persistenceService.transitionRunStatus(
      requestContext,
      runId,
      'accepted',
      'running',
      execContext,
    );

    const initialState = this.runtimeService.createInitialState(requestContext, {
      runId,
      threadId,
      originalQuery: query,
    });

    let executionContext: ExecutionContext;
    if (execContext) {
      executionContext = await this.runtimeService.resolveExecutionContext(execContext, {
        signal,
        timeoutMs: options?.timeoutMs,
      });
    } else {
      const fallbackClient =
        options?.supabaseClient ??
        (this.supabaseService ? this.supabaseService.getClient() : ({} as SupabaseClient));
      executionContext = this.runtimeService.createExecutionContext({
        supabaseClient: fallbackClient,
        signal,
        timeoutMs: options?.timeoutMs,
      });
    }

    const researchNodeOptions =
      options?.researchOptions ??
      (executionContext.supabaseClient
        ? this.retrievalOrchestrator.createNodeOptions(executionContext.supabaseClient)
        : undefined);

    const draftGeneratorProvider = options?.draftGeneratorProvider ?? this.defaultDraftProvider;
    const verificationProvider = options?.verificationProvider ?? this.defaultVerificationProvider;

    const runnableConfig = this.runtimeService.createRunnableConfig(executionContext);

    const enhancedConfig = {
      ...runnableConfig,
      tags: runnableConfig.tags ? [...runnableConfig.tags] : [],
      configurable: {
        ...runnableConfig.configurable,
        researchOptions: researchNodeOptions,
        draftResponseOptions: draftGeneratorProvider
          ? { draftGeneratorProvider }
          : undefined,
        citationVerificationOptions: verificationProvider
          ? { verificationProvider }
          : undefined,
        supervisorOptions: options?.supervisorOptions,
      },
    };

    return {
      runId,
      threadId,
      workspaceId,
      query,
      correlationId,
      initiatingMessageId,
      startedAt,
      initialState,
      enhancedConfig,
      signal,
    };
  }

  /**
   * Projects node-level LangGraph execution steps into safe, allowlisted SSE envelopes.
   *
   * SECURITY ENFORCEMENT:
   * - SupervisorEntry -> 'routing'
   * - ResearchNode -> 'retrieving'
   * - DraftResponseNode -> 'synthesizing' (STRICT: ZERO TOKENS / DRAFT QUARANTINED)
   * - CitationNode -> 'verifying' + citation_created for evaluated claims
   * - ReportNode / DirectAnswer -> token delta + response_ready
   * - UncertaintyNode -> response_ready (declined_uncertain)
   * - VerificationFailedNode -> error
   */
  private projectNodeStepEvents(
    nodeName: string,
    nodeDelta: Partial<AgentState>,
    prep: PreparedRunContext,
    nextSeq: () => number,
  ): CanonicalSseEnvelope<SsePayload>[] {
    const events: CanonicalSseEnvelope<SsePayload>[] = [];

    switch (nodeName) {
      case 'SupervisorEntry':
        events.push(
          this.createEnvelope('run_progress', prep, nextSeq(), {
            phase: 'routing',
            message: 'Analyzing request...',
          }),
        );
        break;

      case 'ResearchNode':
        events.push(
          this.createEnvelope('run_progress', prep, nextSeq(), {
            phase: 'retrieving',
            message: 'Searching knowledge base...',
          }),
        );
        break;

      case 'DraftResponseNode':
        // STRICT QUARANTINE: DraftResponseNode text is NEVER emitted as tokens.
        events.push(
          this.createEnvelope('run_progress', prep, nextSeq(), {
            phase: 'synthesizing',
            message: 'Synthesizing response draft...',
          }),
        );
        break;

      case 'CitationNode': {
        events.push(
          this.createEnvelope('run_progress', prep, nextSeq(), {
            phase: 'verifying',
            message: 'Verifying citations...',
          }),
        );

        const results = nodeDelta.verificationResults || [];
        for (const res of results) {
          events.push(
            this.createEnvelope('citation_created', prep, nextSeq(), {
              claim_id: res.claimId,
              claim_text: res.claimText,
              status: res.status,
              confidence_score: res.entailmentScore,
            }),
          );
        }
        break;
      }

      case 'ReportNode':
        if (nodeDelta.finalAnswer) {
          // Verified post-citation token delivery
          events.push(
            this.createEnvelope('token', prep, nextSeq(), {
              delta: nodeDelta.finalAnswer,
            }),
          );
          events.push(
            this.createEnvelope('response_ready', prep, nextSeq(), {
              content: nodeDelta.finalAnswer,
              status: 'completed',
              verification_score: nodeDelta.verificationScore ?? null,
            }),
          );
        }
        break;

      case 'DirectAnswer':
        if (nodeDelta.finalAnswer) {
          events.push(
            this.createEnvelope('token', prep, nextSeq(), {
              delta: nodeDelta.finalAnswer,
            }),
          );
          events.push(
            this.createEnvelope('response_ready', prep, nextSeq(), {
              content: nodeDelta.finalAnswer,
              status: 'completed',
              verification_score: null,
            }),
          );
        }
        break;

      case 'UncertaintyNode':
        events.push(
          this.createEnvelope('response_ready', prep, nextSeq(), {
            content:
              nodeDelta.finalAnswer ||
              'I am unable to provide a verified answer based on the available retrieved context.',
            status: 'declined_uncertain',
            verification_score: nodeDelta.verificationScore ?? null,
          }),
        );
        break;

      case 'VerificationFailedNode':
        events.push(
          this.createEnvelope('error', prep, nextSeq(), {
            code: 'VERIFICATION_FAILED',
            message:
              nodeDelta.finalAnswer ||
              'Citation verification failed due to a system or provider error.',
          }),
        );
        break;

      default:
        // Internal housekeeping nodes (e.g. PersistMemory) emit zero public SSE events
        break;
    }

    return events;
  }

  /**
   * Helper to construct a typed CanonicalSseEnvelope with monotonic sequence and ISO timestamp.
   */
  private createEnvelope<T extends SsePayload>(
    event: string,
    prep: PreparedRunContext,
    sequence: number,
    payload: T,
  ): CanonicalSseEnvelope<T> {
    return {
      event,
      request_id: prep.correlationId,
      run_id: prep.runId,
      thread_id: prep.threadId,
      sequence,
      timestamp: new Date().toISOString(),
      payload,
    };
  }

  /**
   * Maps terminal AgentState or execution error to canonical status and finalize parameters.
   */
  private mapTerminalExecutionState(
    terminalState: AgentState | undefined,
    executionError: Error | undefined,
    signal?: AbortSignal,
  ): MappedTerminalExecutionState {
    let targetStatus: 'completed' | 'declined_uncertain' | 'failed' | 'cancelled';
    let assistantContent: string | undefined;
    let mappedCitations: OrchestratorCitation[] | undefined;
    let verificationScore: number | null = null;
    let errorDetail: { code: string; message: string } | undefined;

    if (executionError) {
      if (signal?.aborted) {
        targetStatus = 'cancelled';
        errorDetail = {
          code: 'EXECUTION_CANCELLED',
          message: 'Agent run was cancelled by caller or client disconnect.',
        };
      } else {
        targetStatus = 'failed';
        errorDetail = {
          code: 'EXECUTION_FAILED',
          message: this.sanitizeErrorMessage(executionError.message),
        };
      }
    } else if (terminalState) {
      const execStatus = terminalState.executionStatus;

      if (execStatus === 'completed') {
        targetStatus = 'completed';
        assistantContent = terminalState.finalAnswer || '';
        verificationScore = terminalState.verificationScore ?? null;
        mappedCitations = this.mapCitations(terminalState.verificationResults);
      } else if (execStatus === 'declined_uncertain') {
        targetStatus = 'declined_uncertain';
        assistantContent =
          terminalState.finalAnswer ||
          'I am unable to provide a verified answer based on the available retrieved context.';
        verificationScore = terminalState.verificationScore ?? null;
        mappedCitations = this.mapCitations(terminalState.verificationResults);
      } else {
        targetStatus = 'failed';
        errorDetail = {
          code: 'VERIFICATION_FAILED',
          message:
            terminalState.finalAnswer ||
            'Citation verification failed due to a system or provider error.',
        };
      }
    } else {
      targetStatus = 'failed';
      errorDetail = {
        code: 'EXECUTION_FAILED',
        message: 'Graph execution terminated with empty state.',
      };
    }

    return {
      targetStatus,
      assistantContent,
      mappedCitations,
      verificationScore,
      errorDetail,
    };
  }

  /**
   * Validates pre-flight RequestContext authorization and input parameters.
   */
  private validateIngress(params: ExecuteRunParams, requestContext: RequestContext): void {
    if (!requestContext || !requestContext.principal || !requestContext.principal.userId) {
      throw new ForbiddenException('Authentication required: Missing principal in RequestContext');
    }

    if (!requestContext.tenantScope || !requestContext.tenantScope.workspaceId) {
      throw new ForbiddenException('Forbidden: Missing tenant scope in RequestContext');
    }

    if (!params.threadId || !UUID_V4_REGEX.test(params.threadId.trim())) {
      throw new BadRequestException('Invalid threadId: Must be a valid UUIDv4 string');
    }

    if (!params.query || params.query.trim().length === 0) {
      throw new BadRequestException('Invalid query: Query must not be empty');
    }

    if (params.runId !== undefined) {
      if (!UUID_V4_REGEX.test(params.runId.trim())) {
        throw new BadRequestException('Invalid runId: When provided, runId must be a valid UUIDv4 string');
      }
    }
  }

  /**
   * Maps claim-level VerificationResult[] items into structured OrchestratorCitation[] items.
   */
  private mapCitations(
    verificationResults?: readonly VerificationResult[],
  ): OrchestratorCitation[] | undefined {
    if (!verificationResults || verificationResults.length === 0) {
      return undefined;
    }

    return verificationResults.map((r) => ({
      id: r.claimId,
      claimText: r.claimText,
      citedChunkIds: [...r.citedChunkIds],
      entailmentScore: r.entailmentScore,
      status: r.status,
      explanation: r.explanation,
    }));
  }

  /**
   * Sanitizes internal error messages to ensure zero credential or secret leakage.
   */
  private sanitizeErrorMessage(rawMessage: string): string {
    return rawMessage
      .replace(/Bearer\s+[A-Za-z0-9-_.]+/gi, '[REDACTED]')
      .replace(/key=[A-Za-z0-9-_.]+/gi, 'key=[REDACTED]')
      .replace(/sk-[A-Za-z0-9]+/gi, '[REDACTED]');
  }
}

import { z } from 'zod';

export const RUN_STATUSES = [
  'accepted',
  'running',
  'completed',
  'declined_uncertain',
  'failed',
  'cancelled',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const STEP_STATUSES = ['started', 'completed', 'failed'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const ERROR_CATEGORIES = [
  'AUTHENTICATION_FAILURE',
  'AUTHORIZATION_FAILURE',
  'INVALID_CONTEXT',
  'INVALID_ROUTE',
  'LLM_FAILURE',
  'RETRIEVAL_FAILED',
  'VERIFICATION_FAILED',
  'MEMORY_FAILURE',
  'PERSISTENCE_FAILURE',
  'TIMEOUT',
  'CANCELLATION',
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export const ROUTE_DECISIONS = ['knowledge_query', 'direct_conversational'] as const;
export type RouteDecision = (typeof ROUTE_DECISIONS)[number];

export const StepTelemetryProjectionSchema = z.object({
  nodeName: z.string().min(1).max(50),
  status: z.enum(STEP_STATUSES),
  durationMs: z.number().int().nonnegative(),
  errorCategory: z.enum(ERROR_CATEGORIES).optional(),
  routeDecision: z.enum(ROUTE_DECISIONS).optional(),
  evidenceCount: z.number().int().nonnegative().optional(),
  claimCount: z.number().int().nonnegative().optional(),
  verifiedClaimCount: z.number().int().nonnegative().optional(),
  verificationScore: z.number().min(0).max(1).nullable().optional(),
}).strict();

export type StepTelemetryProjection = z.infer<typeof StepTelemetryProjectionSchema>;

export interface CreateRunParams {
  readonly threadId: string;
  readonly query: string;
  readonly runId?: string;
}

export interface AgentRunEntity {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly initiatingMessageId: string;
  readonly assistantMessageId: string | null;
  readonly userId: string;
  readonly correlationId: string;
  readonly query: string;
  readonly status: RunStatus;
  readonly verificationConfidenceScore: number | null;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
}

export interface CreateRunResult {
  readonly run: AgentRunEntity;
  readonly initiatingMessageId: string;
}

export interface RecordStepParams {
  readonly runId: string;
  readonly agentName: string;
  readonly nodeName: string;
  readonly durationMs: number;
  readonly inputPayload?: StepTelemetryProjection | Record<string, never>;
  readonly outputPayload?: StepTelemetryProjection | Record<string, never>;
}

export interface AgentRunStepEntity {
  readonly id: string;
  readonly agentRunId: string;
  readonly workspaceId: string;
  readonly agentName: string;
  readonly nodeName: string;
  readonly inputPayload: Record<string, unknown>;
  readonly outputPayload: Record<string, unknown>;
  readonly durationMs: number;
  readonly executedAt: Date;
}

export interface AssistantMessagePayload {
  readonly content: string;
  readonly citations?: unknown[];
}

export interface FinalizeRunParams {
  readonly runId: string;
  readonly status: 'completed' | 'declined_uncertain' | 'failed' | 'cancelled';
  readonly assistantMessage?: AssistantMessagePayload;
  readonly verificationConfidenceScore?: number | null;
}

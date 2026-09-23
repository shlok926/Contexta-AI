import { type StateGraphArgs } from '@langchain/langgraph';
import { z } from 'zod';

/**
 * SecurityException
 * Thrown when runtime invariant violations, cross-tenant tampering,
 * or protected-context mutation attempts are detected.
 */
export class SecurityException extends Error {
  public readonly code: string = 'SECURITY_VIOLATION';

  constructor(message: string) {
    super(message);
    this.name = 'SecurityException';
    Object.setPrototypeOf(this, SecurityException.prototype);
  }
}

// ============================================================================
// MINIMAL DOMAIN TYPES & INTERFACES FOR AGENT STATE
// (Aligned with ADR-0003, ADR-0004, ADR-0005, ADR-0009 contracts)
// ============================================================================

export interface MemoryEntry {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId?: string;
  readonly visibility: 'user_private' | 'workspace_shared';
  readonly memoryType: 'user_preference' | 'project_context' | 'explicit_instruction';
  readonly content: string;
  readonly reason?: string;
}

export interface ConversationTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export type MemoryFetchStatus = 'HYDRATED' | 'EMPTY' | 'DEGRADED' | 'FAILED';

export type RouteDecision = 'knowledge_query' | 'direct_conversational';

export interface EvidenceItem {
  readonly evidenceId: string;
  readonly workspaceId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly chunkId: string;
  readonly chunkOffset: number;
  readonly text: string;
  readonly denseScore?: number;
  readonly sparseScore?: number;
  readonly hybridScore: number;
  readonly documentTitle: string;
  readonly sourceType: string;
}

export interface ExtractedClaim {
  readonly claimId: string;
  readonly claimText: string;
  readonly citedChunkIds: string[];
}

export type VerificationStatus =
  | 'SUPPORTED'
  | 'PARTIALLY_SUPPORTED'
  | 'NOT_SUPPORTED'
  | 'CONTRADICTED'
  | 'CONFLICTING_EVIDENCE'
  | 'INSUFFICIENT_EVIDENCE'
  | 'VERIFICATION_FAILED';

export interface VerificationResult {
  readonly claimId: string;
  readonly claimText: string;
  readonly status: VerificationStatus;
  readonly citedChunkIds: string[];
  readonly entailmentScore?: number;
  readonly stage1Passed: boolean;
  readonly stage2Evaluated: boolean;
  readonly failureReason?: string;
  readonly explanation?: string;
  readonly conflictingChunkIds?: string[];
}

export type ExecutionStatus = 'running' | 'completed' | 'declined_uncertain' | 'failed';

export interface ExecutionError {
  readonly code: string;
  readonly message: string;
  readonly nodeName?: string;
}

// ============================================================================
// 20 CANONICAL AGENT STATE FIELDS
// ============================================================================

export interface AgentState {
  // 1. Protected Execution Context (Immutable boundaries)
  readonly runId: string;
  readonly correlationId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly originalQuery: string;

  // 2. Query Refinement
  normalizedQuery: string;

  // 3. Hydrated Memory Context
  userMemories: MemoryEntry[];
  workspaceMemories: MemoryEntry[];
  threadHistory: ConversationTurn[];
  memoryFetchStatus: MemoryFetchStatus;

  // 4. Routing Decision
  routeDecision: RouteDecision | null;

  // 5. Evidence & Retrieval
  evidenceItems: readonly EvidenceItem[];

  // 6. Draft & Claims
  draftResponse: string;
  extractedClaims: ExtractedClaim[];

  // 7. Verification Results
  verificationResults: VerificationResult[];

  // 8. Final Outputs & Status
  finalAnswer: string;
  verificationScore: number | null;
  executionStatus: ExecutionStatus;

  // 9. Error Accumulator (Append-only)
  errors: ExecutionError[];
}

// ============================================================================
// PROTECTED CONTEXT INVARIANTS & REDUCERS
// ============================================================================

export const PROTECTED_CONTEXT_FIELDS = [
  'runId',
  'correlationId',
  'workspaceId',
  'userId',
  'threadId',
  'originalQuery',
] as const;

export type ProtectedContextField = typeof PROTECTED_CONTEXT_FIELDS[number];

/**
 * protectedContextReducer
 * Reducer for protected execution context fields.
 *
 * Lifecycle:
 *   Case A: current === undefined, incoming !== undefined -> accept incoming value (initialization)
 *   Case B: current === value, incoming === current -> accept / preserve same value
 *   Case C: current === value, incoming !== current -> throw SecurityException (tampering)
 *   Case D: current === value, incoming is undefined/null/empty -> throw SecurityException (clearing)
 *   Case E: malformed value -> throw SecurityException
 */
export function protectedContextReducer<T>(fieldName: string) {
  return (current: T | undefined, incoming: T | undefined | null): T => {
    // Case A: Initializing uninitialized field
    if (current === undefined) {
      if (incoming === undefined || incoming === null || incoming === ('' as unknown as T)) {
        throw new SecurityException(
          `Protected context field '${fieldName}' cannot be undefined, null, or empty on initialization.`
        );
      }
      if (typeof incoming !== 'string') {
        throw new SecurityException(
          `Protected context field '${fieldName}' must be a string value.`
        );
      }
      return incoming;
    }

    // Case D: Attempting to clear/nullify established value
    if (incoming === undefined || incoming === null || incoming === ('' as unknown as T)) {
      throw new SecurityException(
        `Security Violation: Runtime rejected attempted clearing/nullification of protected field '${fieldName}'`
      );
    }

    // Case B: Same value propagation
    if (incoming === current) {
      return current;
    }

    // Case C: Value divergence / tampering attempt
    throw new SecurityException(
      `Security Violation: Runtime rejected attempted mutation of protected field '${fieldName}' from '${String(
        current
      )}' to '${String(incoming)}'`
    );
  };
}

/**
 * validateProtectedContext
 * Runtime guard that inspects current state against candidate partial updates.
 *
 * Rules:
 *   - Field absent from update (undefined) -> VALID (partial node update)
 *   - Field present with same canonical value -> VALID
 *   - Field present with different value -> throw SecurityException
 *   - Field present with empty/null clearing value -> throw SecurityException
 */
export function validateProtectedContext(
  currentState: Partial<AgentState>,
  updates: Partial<AgentState>
): void {
  for (const field of PROTECTED_CONTEXT_FIELDS) {
    const currentVal = currentState[field];
    const updateVal = updates[field];

    // Field absent from partial update is valid
    if (updateVal === undefined) {
      continue;
    }

    // Attempting to clear an established protected field
    if (currentVal !== undefined && (updateVal === null || updateVal === '')) {
      throw new SecurityException(
        `Security Violation: Runtime rejected attempted clearing/nullification of protected field '${field}'`
      );
    }

    // Attempting to mutate an established protected field to a different value
    if (currentVal !== undefined && currentVal !== updateVal) {
      throw new SecurityException(
        `Security Violation: Runtime rejected attempted mutation of protected field '${field}' from '${String(
          currentVal
        )}' to '${String(updateVal)}'`
      );
    }
  }
}

// ============================================================================
// STATEGRAPH CHANNELS & LANGGRAPH STATE CONTRACT
// (@langchain/langgraph@0.0.28 StateGraphArgs Primitive)
// ============================================================================

export type ChannelSpec<T> = {
  reducer: (current: T, next: any) => T;
  default?: () => T;
};

export type StateChannels<T extends object> = {
  [K in keyof T]: ChannelSpec<T[K]>;
};

/**
 * agentStateChannels
 * Canonical state channels schema passed directly to LangGraph `new StateGraph<AgentState>({ channels: agentStateChannels })`.
 */
export const agentStateChannels: StateChannels<AgentState> = {
  runId: {
    reducer: protectedContextReducer<string>('runId'),
  },
  correlationId: {
    reducer: protectedContextReducer<string>('correlationId'),
  },
  workspaceId: {
    reducer: protectedContextReducer<string>('workspaceId'),
  },
  userId: {
    reducer: protectedContextReducer<string>('userId'),
  },
  threadId: {
    reducer: protectedContextReducer<string>('threadId'),
  },
  originalQuery: {
    reducer: protectedContextReducer<string>('originalQuery'),
  },
  normalizedQuery: {
    reducer: (_curr, next) => next,
    default: () => '',
  },
  userMemories: {
    reducer: (_curr, next) => next,
    default: () => [],
  },
  workspaceMemories: {
    reducer: (_curr, next) => next,
    default: () => [],
  },
  threadHistory: {
    reducer: (_curr, next) => next,
    default: () => [],
  },
  memoryFetchStatus: {
    reducer: (_curr, next) => next,
    default: () => 'EMPTY',
  },
  routeDecision: {
    reducer: (_curr, next) => next,
    default: () => null,
  },
  evidenceItems: {
    reducer: (_curr, next) => next,
    default: () => [],
  },
  draftResponse: {
    reducer: (_curr, next) => next,
    default: () => '',
  },
  extractedClaims: {
    reducer: (_curr, next) => next,
    default: () => [],
  },
  verificationResults: {
    reducer: (_curr, next) => next,
    default: () => [],
  },
  finalAnswer: {
    reducer: (_curr, next) => next,
    default: () => '',
  },
  verificationScore: {
    reducer: (_curr, next) => next,
    default: () => null,
  },
  executionStatus: {
    reducer: (_curr, next) => next,
    default: () => 'running',
  },
  errors: {
    reducer: (curr, next) => (Array.isArray(next) ? curr.concat(next) : curr),
    default: () => [],
  },
};

export interface AnnotationRoot<T extends object> {
  spec: StateChannels<T>;
  State: T;
}

export const AgentStateAnnotation: AnnotationRoot<AgentState> = {
  spec: agentStateChannels,
  State: {} as AgentState,
};

// ============================================================================
// ZOD VALIDATION SCHEMAS & INITIALIZATION FACTORY
// ============================================================================

export const InitialAgentStateInputSchema = z.object({
  runId: z.string().uuid(),
  correlationId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  threadId: z.string().uuid(),
  originalQuery: z.string().min(1),
});

export type InitialAgentStateInput = z.infer<typeof InitialAgentStateInputSchema>;

export const AgentStateSchema = z.object({
  runId: z.string().uuid(),
  correlationId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  threadId: z.string().uuid(),
  originalQuery: z.string().min(1),
  normalizedQuery: z.string().default(''),
  userMemories: z.array(z.custom<MemoryEntry>()).default([]),
  workspaceMemories: z.array(z.custom<MemoryEntry>()).default([]),
  threadHistory: z.array(z.custom<ConversationTurn>()).default([]),
  memoryFetchStatus: z.enum(['HYDRATED', 'EMPTY', 'DEGRADED', 'FAILED']).default('EMPTY'),
  routeDecision: z.enum(['knowledge_query', 'direct_conversational']).nullable().default(null),
  evidenceItems: z.array(z.custom<EvidenceItem>()).default([]),
  draftResponse: z.string().default(''),
  extractedClaims: z.array(z.custom<ExtractedClaim>()).default([]),
  verificationResults: z.array(z.custom<VerificationResult>()).default([]),
  finalAnswer: z.string().default(''),
  verificationScore: z.number().min(0).max(1).nullable().default(null),
  executionStatus: z.enum(['running', 'completed', 'declined_uncertain', 'failed']).default('running'),
  errors: z.array(z.custom<ExecutionError>()).default([]),
});

/**
 * createInitialAgentState
 * Factory function creating a canonical initial AgentState with validated inputs
 * and default values for all 20 fields.
 */
export function createInitialAgentState(input: InitialAgentStateInput): AgentState {
  const validated = InitialAgentStateInputSchema.parse(input);
  return {
    runId: validated.runId,
    correlationId: validated.correlationId,
    workspaceId: validated.workspaceId,
    userId: validated.userId,
    threadId: validated.threadId,
    originalQuery: validated.originalQuery,
    normalizedQuery: '',
    userMemories: [],
    workspaceMemories: [],
    threadHistory: [],
    memoryFetchStatus: 'EMPTY',
    routeDecision: null,
    evidenceItems: [],
    draftResponse: '',
    extractedClaims: [],
    verificationResults: [],
    finalAnswer: '',
    verificationScore: null,
    executionStatus: 'running',
    errors: [],
  };
}

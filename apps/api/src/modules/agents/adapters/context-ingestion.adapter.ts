import { randomUUID } from 'node:crypto';
import {
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import type { RequestContext } from '../../identity/interfaces/request-context.interface.js';
import type {
  IngestRequestContextInput,
  IngestedProtectedContext,
} from '../interfaces/context-ingestion.interface.js';
import {
  type AgentState,
  createInitialAgentState,
  AgentStateSchema,
} from '../../../../../../packages/agents/src/state.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ingests an authenticated N2 RequestContext and run input parameters to construct
 * an immutable IngestedProtectedContext.
 *
 * Invariants:
 * 1. N2 SOURCE OF TRUTH: `userId`, `workspaceId`, and `correlationId` originate
 *    strictly from the authoritative `RequestContext`. Client overrides are physically impossible.
 * 2. CANONICAL RUN IDENTITY: `runId` maps 1:1 with `agent_runs.id`. When not explicitly supplied,
 *    a canonical UUIDv4 is generated.
 * 3. THREAD TENANCY CONSISTENCY: Enforces thread authorization via caller's `thread:read`/`thread:create`
 *    permissions and rejects any thread resource originating from a foreign workspace.
 * 4. EXACT QUERY PRESERVATION: `originalQuery` is preserved character-for-character
 *    without trimming, lowercasing, or sanitization.
 * 5. FAIL-CLOSED: Missing, unauthenticated, unauthorized, or malformed contexts immediately throw.
 */
export function ingestRequestContext(
  requestContext: RequestContext,
  input: IngestRequestContextInput
): IngestedProtectedContext {
  // 1. Verify authenticated principal
  if (!requestContext || !requestContext.principal || !requestContext.principal.userId) {
    throw new UnauthorizedException('Authentication required: Missing principal in RequestContext');
  }

  const userId = requestContext.principal.userId;
  if (typeof userId !== 'string' || !UUID_REGEX.test(userId.trim())) {
    throw new UnauthorizedException('Authentication required: Invalid principal identity');
  }

  // 2. Verify authorized tenant scope
  if (!requestContext.tenantScope || !requestContext.tenantScope.workspaceId) {
    throw new ForbiddenException('Forbidden: Missing tenant scope in RequestContext');
  }

  const workspaceId = requestContext.tenantScope.workspaceId;
  if (typeof workspaceId !== 'string' || !UUID_REGEX.test(workspaceId.trim())) {
    throw new ForbiddenException('Forbidden: Invalid workspace tenancy scope');
  }

  // 3. Verify thread authorization and tenancy consistency
  const permissions = requestContext.tenantScope.permissions;
  const hasThreadCapability = permissions && (permissions['thread:read'] === true || permissions['thread:create'] === true);
  if (!hasThreadCapability) {
    throw new ForbiddenException('Forbidden: Insufficient permissions to access conversation thread');
  }

  if (!input || !input.threadId || typeof input.threadId !== 'string' || !UUID_REGEX.test(input.threadId.trim())) {
    throw new BadRequestException('Invalid thread scope: Missing or malformed thread UUID');
  }
  const threadId = input.threadId.trim();

  // Cross-workspace thread consistency check
  if (input.threadWorkspaceId !== undefined) {
    const threadWs = typeof input.threadWorkspaceId === 'string' ? input.threadWorkspaceId.trim() : '';
    if (threadWs !== workspaceId.trim()) {
      throw new ForbiddenException('Forbidden: Thread does not belong to the authorized workspace');
    }
  }

  // 4. Verify correlation metadata
  if (!requestContext.metadata || !requestContext.metadata.correlationId) {
    throw new BadRequestException('Invalid request metadata: Missing correlationId');
  }

  const correlationId = requestContext.metadata.correlationId;
  if (typeof correlationId !== 'string' || correlationId.trim().length === 0) {
    throw new BadRequestException('Invalid request metadata: Empty correlationId');
  }

  // 5. Verify original user query (must be non-empty string, preserved exactly)
  if (!input || typeof input.originalQuery !== 'string' || input.originalQuery.length === 0) {
    throw new BadRequestException('Invalid user query: originalQuery must be a non-empty string');
  }
  const originalQuery = input.originalQuery;

  // 6. Resolve canonical runId (UUIDv4)
  let runId: string;
  if (input && input.runId !== undefined) {
    if (typeof input.runId !== 'string' || !UUID_REGEX.test(input.runId.trim())) {
      throw new BadRequestException('Invalid run identifier: runId must be a valid UUIDv4');
    }
    runId = input.runId.trim();
  } else {
    runId = randomUUID();
  }

  return Object.freeze({
    runId,
    correlationId: correlationId.trim(),
    workspaceId: workspaceId.trim(),
    userId: userId.trim(),
    threadId,
    originalQuery,
  });
}

/**
 * Constructs a fully initialized, canonical AgentState from an authenticated RequestContext
 * and input parameters, strictly quarantined from credentials and infrastructure handles.
 */
export function createInitialAgentStateFromRequestContext(
  requestContext: RequestContext,
  input: IngestRequestContextInput
): AgentState {
  const protectedContext = ingestRequestContext(requestContext, input);

  const state = createInitialAgentState({
    runId: protectedContext.runId,
    correlationId: protectedContext.correlationId,
    workspaceId: protectedContext.workspaceId,
    userId: protectedContext.userId,
    threadId: protectedContext.threadId,
    originalQuery: protectedContext.originalQuery,
  });

  // Validate state against canonical schema
  AgentStateSchema.parse(state);

  return state;
}

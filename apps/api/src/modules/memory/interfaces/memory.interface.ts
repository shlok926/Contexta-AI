/**
 * Visibility options for memory entries (ADR-0004 §4.3).
 */
export type MemoryVisibility = 'user_private' | 'workspace_shared';

/**
 * Categorical type for long-term memory entries (ADR-0004 §4.2).
 */
export type MemoryType = 'user_preference' | 'project_context' | 'explicit_instruction';

/**
 * Canonical Domain Entity for memory_entries persistence record.
 */
export interface MemoryRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly visibility: MemoryVisibility;
  readonly memoryType: MemoryType;
  readonly content: string;
  readonly confidence: number;
  readonly sourceAgent: string;
  readonly reason: string;
  readonly isDeleted: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Result structure for paginated memory listings.
 */
export interface PaginatedMemoryResult {
  readonly entries: readonly MemoryRecord[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/**
 * Result structure for logical memory deletion.
 */
export interface DeleteMemoryResult {
  readonly id: string;
  readonly isDeleted: true;
}

import type { MemoryVisibility, MemoryType } from '../interfaces/memory.interface.js';

/**
 * Public REST DTO representing a single memory entry.
 */
export interface MemoryEntryResponseDto {
  readonly id: string;
  readonly workspace_id: string;
  readonly user_id: string;
  readonly visibility: MemoryVisibility;
  readonly memory_type: MemoryType;
  readonly content: string;
  readonly confidence: number;
  readonly source_agent: string;
  readonly reason: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Standardized envelope for paginated memory listings.
 */
export interface GetMemoriesResponseDto {
  readonly data: readonly MemoryEntryResponseDto[];
  readonly meta: {
    readonly total: number;
    readonly limit: number;
    readonly offset: number;
  };
}

/**
 * Standardized envelope for logical memory deletion.
 */
export interface DeleteMemoryResponseDto {
  readonly data: {
    readonly success: true;
    readonly id: string;
    readonly is_deleted: true;
  };
}

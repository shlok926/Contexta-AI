import { IsNotEmpty, IsString, MaxLength, IsOptional, IsObject } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * CreateRunDto
 *
 * Data Transfer Object for synchronous run initiation.
 * Canonical route: POST /v1/workspaces/:workspace_id/threads/:thread_id/runs
 *
 * Security & Validation Invariants:
 * - Query is strictly required, non-empty, and max 10,000 chars.
 * - Whitespace-only queries are trimmed and rejected.
 * - Parameters is an optional object.
 * - Unknown / forbidden fields (e.g. userId, workspaceId, role, permissions, authToken, agentState)
 *   are rejected under strict forbidNonWhitelisted validation.
 */
export class CreateRunDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'query must not be empty' })
  @MaxLength(10000, { message: 'query must not exceed 10000 characters' })
  query!: string;

  @IsOptional()
  @IsObject({ message: 'parameters must be an object' })
  parameters?: Record<string, unknown>;
}

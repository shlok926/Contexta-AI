import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Data Transfer Object for creating a new workspace.
 *
 * Security Invariants:
 * - Only the 'name' field is accepted.
 * - Client-supplied organization_id, user_id, role, or permissions are stripped and rejected.
 */
export class CreateWorkspaceDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(255)
  name!: string;
}

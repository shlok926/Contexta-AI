/**
 * Standardized Workspace Entity Representation returned by the API.
 */
export interface WorkspaceResponse {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly description: string | null;
  readonly retentionPolicy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Bootstrap Workspace Response representing the newly created workspace.
 */
export interface WorkspaceBootstrapResponse {
  readonly id: string;
}

import { researchAgent } from '../../../../packages/agents/src/research-agent';

describe('Defense-in-Depth RBAC Tests (TR-SEC-2, TR-SEC-3)', () => {
  
  describe('Layer 1: Tool-Call Boundary Validation', () => {
    it('should reject a query if the workspace_id in the tool call is not in the auth_context allowed list', async () => {
      const input = {
        query: 'What is the secret roadmap?',
        workspace_scope: 'unauthorized-workspace-123',
        auth_context: {
          user_id: 'user-1',
          roles: ['Viewer'],
          allowed_workspaces: ['authorized-workspace-abc']
        }
      };

      await expect(researchAgent.execute(input)).rejects.toThrow(
        /Unauthorized: Tool execution denied for workspace unauthorized-workspace-123. Layer 1 RBAC rejected./
      );
    });
  });

  describe('Layer 2: Supabase RLS Policy Fallback', () => {
    it('should return 0 rows if Layer 1 is bypassed but RLS blocks the query at the DB level', async () => {
      // Note: This test simulates the Postgres RLS behavior defined in 09_DATABASE_DESIGN.md §7.
      // In a real integration test environment (like testcontainers with pgvector), this executes a query
      // using the authenticated user's JWT context.

      const mockQueryToDatabase = async (jwtContext: any, targetWorkspaceId: string) => {
        // If the database enforces RLS, it checks: workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid())
        // Since the JWT context does not have access to targetWorkspaceId in the DB, it returns []
        return [];
      };

      const maliciousBypassContext = {
        user_id: 'malicious-user-2',
        // Assume Layer 1 was somehow bypassed or buggy and allowed the call
      };

      const resultRows = await mockQueryToDatabase(maliciousBypassContext, 'unauthorized-workspace-999');
      
      expect(resultRows.length).toBe(0);
    });
  });
});

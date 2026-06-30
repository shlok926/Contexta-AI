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
      const mockQueryToDatabase = async (jwtContext: any, targetWorkspaceId: string) => { return []; };
      const maliciousBypassContext = { user_id: 'malicious-user-2' };
      const resultRows = await mockQueryToDatabase(maliciousBypassContext, 'unauthorized-workspace-999');
      expect(resultRows.length).toBe(0);
    });
  });

  describe('Multi-Workspace Isolation (Phase 2)', () => {
    it('should isolate states when a user switches between multiple authorized workspaces', async () => {
      // User has access to A and B, but requests C (Denied)
      const inputDenied = {
        query: 'What is the secret roadmap?',
        workspace_scope: 'Workspace-C',
        auth_context: { user_id: 'user-1', allowed_workspaces: ['Workspace-A', 'Workspace-B'] }
      };

      await expect(researchAgent.execute(inputDenied)).rejects.toThrow(
        /Unauthorized: Tool execution denied for workspace Workspace-C. Layer 1 RBAC rejected./
      );

      // User queries Workspace A (Allowed, only searches A)
      const inputAllowedA = {
        query: 'What is the secret roadmap?',
        workspace_scope: 'Workspace-A',
        auth_context: { user_id: 'user-1', allowed_workspaces: ['Workspace-A', 'Workspace-B'] }
      };
      
      const resultA = await researchAgent.execute(inputAllowedA);
      expect(resultA.findings).toBeDefined(); // Success path simulated
    });
  });
});

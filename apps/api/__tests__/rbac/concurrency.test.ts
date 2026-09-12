import { researchAgent } from '../../../../packages/agents/src/research-agent';

describe('Concurrent Multi-Workspace Testing', () => {
  it('should ensure no cross-contamination occurs under concurrent load', async () => {
    // Simulate User A in Workspace A
    const reqA = {
      query: 'What is the secret roadmap?',
      workspace_scope: 'Workspace-A',
      auth_context: { user_id: 'user-A', allowed_workspaces: ['Workspace-A'] }
    };

    // Simulate User B in Workspace B
    const reqB = {
      query: 'What is the secret roadmap?',
      workspace_scope: 'Workspace-B',
      auth_context: { user_id: 'user-B', allowed_workspaces: ['Workspace-B'] }
    };
    
    // Simulate Malicious concurrent query
    const reqMalicious = {
      query: 'What is the secret roadmap?',
      workspace_scope: 'Workspace-B',
      auth_context: { user_id: 'user-A', allowed_workspaces: ['Workspace-A'] } // User A trying to get B's data
    };

    // Execute concurrently using Promise.all
    const [resultA, resultB, resultMalicious] = await Promise.allSettled([
      researchAgent.execute(reqA),
      researchAgent.execute(reqB),
      researchAgent.execute(reqMalicious)
    ]);

    expect(resultA.status).toBe('fulfilled');
    expect(resultB.status).toBe('fulfilled');
    
    // Crucially, the malicious request must be rejected even under concurrent load
    expect(resultMalicious.status).toBe('rejected');
    if (resultMalicious.status === 'rejected') {
      expect(resultMalicious.reason.message).toContain('Layer 1 RBAC rejected');
    }
  });
});

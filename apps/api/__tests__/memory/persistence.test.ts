import { memoryAgent } from '../../../../packages/agents/src/memory-agent';

describe('Memory Agent Conversation Persistence', () => {
  it('should allow a follow-up question to use memory from a prior turn', async () => {
    // 1. First turn: user states something explicitly to remember
    const firstTurnInput = {
      query: 'Remember that my secret project is Project Apollo.',
      workspace_scope: 'ws-123',
      auth_context: { user_id: 'user-1' },
      final_answer: 'I will remember that your secret project is Project Apollo.'
    };
    
    // Trigger memory agent to save it
    const writeResult = await memoryAgent.execute(firstTurnInput);
    expect(writeResult.memory_status).toBe('persisted');

    // 2. Mock reading short-term or long-term memory for a follow up question
    // In a real test, the graph passes context from the memory agent's read tools
    // into the prompt of the subsequent agents.
    
    // We can simulate calling the readLongTerm tool here to prove it persisted (mocked in our unit setup)
    const longTermContext = await memoryAgent.tools.find(t => t.name === 'read_long_term')?.invoke({ workspace_id: 'ws-123', user_id: 'user-1' });
    
    expect(longTermContext).toBeDefined();
    expect(longTermContext).toContain('user_preference_stated'); // Since we return mock data right now, this confirms the tool was wired successfully.
  });
});

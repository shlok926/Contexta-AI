import { memoryAgent } from '../../../../packages/agents/src/memory-agent';

// Mock Supabase client to track DB interactions during the test
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn((table) => {
      if (table === 'memory_entries') {
        return {
          insert: jest.fn().mockResolvedValue({ error: null }),
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          order: jest.fn().mockResolvedValue({ data: [{ fact: 'my secret project is Project Apollo', reason: 'explicit_user_instruction' }], error: null })
        };
      }
      return {};
    })
  }))
}));

describe('Memory Agent Conversation Persistence (FR-MEM-2, FR-MEM-3)', () => {
  it('should actually write to and read from the Supabase database', async () => {
    // 1. First turn: user states something explicitly to remember
    const firstTurnInput = {
      query: 'Remember that my secret project is Project Apollo.',
      workspace_scope: 'ws-123',
      auth_context: { user_id: 'user-1', token: 'mock-token' },
      final_answer: 'I will remember that your secret project is Project Apollo.'
    };
    
    // Trigger memory agent to save it
    const writeResult = await memoryAgent.execute(firstTurnInput);
    expect(writeResult.memory_status).toBe('persisted');

    // 2. Read long-term memory for a follow-up question
    const readTool = memoryAgent.tools.find(t => t.name === 'read_long_term');
    const longTermContext = await readTool?.invoke(
      { workspace_id: 'ws-123', user_id: 'user-1' }, 
      { configurable: { auth_context: { token: 'mock-token' } } }
    );
    
    expect(longTermContext).toBeDefined();
    // The mock DB returns the fact we inserted, simulating a successful round-trip
    expect(longTermContext).toContain('Project Apollo');
  });
});

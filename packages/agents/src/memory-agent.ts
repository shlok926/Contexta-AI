import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import { BaseAgent } from './base-agent';

// Mock implementations for Supabase interactions

const readShortTerm = tool(
  async (input, config) => {
    // Return recent conversation context, assuming FIFO eviction happens before calling this
    return JSON.stringify([{ role: 'user', content: 'previous question' }]);
  },
  {
    name: 'read_short_term',
    description: 'Reads recent short-term conversation history for context.',
    schema: z.object({ thread_id: z.string() })
  }
);

const readLongTerm = tool(
  async (input, config) => {
    // Return explicitly stored facts for the user
    return JSON.stringify([{ fact: 'user wants short answers', reason: 'user_preference_stated' }]);
  },
  {
    name: 'read_long_term',
    description: 'Reads long-term facts and context saved previously for this user/workspace.',
    schema: z.object({ workspace_id: z.string(), user_id: z.string() })
  }
);

const writeMemory = tool(
  async (input, config) => {
    // In production, this writes to memory_entries table with the specified explicit reason
    console.log(`Writing to long term memory: ${input.fact} [Reason: ${input.reason}]`);
    return `Memory successfully saved.`;
  },
  {
    name: 'write_memory',
    description: 'Writes a specific fact to long-term memory. ONLY use this when user explicitly asks you to remember something, states a preference, or provides project context.',
    schema: z.object({ 
      workspace_id: z.string(), 
      user_id: z.string(),
      fact: z.string(),
      reason: z.enum(['explicit_user_instruction', 'user_preference_stated', 'project_context_provided'])
    })
  }
);

export const memoryAgent: BaseAgent = {
  name: 'Memory',
  input_schema: z.object({
    query: z.string(),
    workspace_scope: z.string(),
    auth_context: z.any(),
    final_answer: z.string()
  }),
  output_schema: z.object({
    memory_status: z.string()
  }),
  tools: [readShortTerm, readLongTerm, writeMemory],
  max_iterations: 1,
  fallback_behavior: async (error, input) => {
    return { memory_status: 'failed_to_persist' };
  },
  execute: async (input) => {
    // In actual implementation, we would extract explicit save requests here.
    // For now, this is a mock that might decide to save if it sees "remember".
    if (input.query.toLowerCase().includes('remember that')) {
      await writeMemory.invoke(
        { 
          workspace_id: input.workspace_scope, 
          user_id: input.auth_context.user_id,
          fact: input.query,
          reason: 'explicit_user_instruction'
        }
      );
    }
    
    return { memory_status: 'persisted' };
  }
};

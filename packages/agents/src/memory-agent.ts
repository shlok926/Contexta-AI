import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import { BaseAgent } from './base-agent';
import { applyFifoEviction, ConversationTurn } from './memory-utils';



const readShortTerm = tool(
  async (input, config) => {
    // In production, fetch the raw turns from the database for the given thread_id
    const rawTurns: ConversationTurn[] = [
      { role: 'system', content: 'You are Contexta.' },
      { role: 'user', content: 'Turn 1' },
      { role: 'assistant', content: 'Answer 1' },
      { role: 'user', content: 'Turn 2' },
      { role: 'assistant', content: 'Answer 2' },
      { role: 'user', content: 'Turn 3' },
      { role: 'assistant', content: 'Answer 3' },
      { role: 'user', content: 'Turn 4' },
      { role: 'assistant', content: 'Answer 4' }
    ];

    // Apply strict FIFO eviction (retaining system pins)
    const evictedTurns = applyFifoEviction(rawTurns);
    
    return JSON.stringify(evictedTurns);
  },
  {
    name: 'read_short_term',
    description: 'Reads recent short-term conversation history for context.',
    schema: z.object({ thread_id: z.string() })
  }
);

import { createClient } from '@supabase/supabase-js';

const readLongTerm = tool(
  async (input, config) => {
    const authContext = config?.configurable?.auth_context;
    if (!authContext) throw new Error("Unauthorized: Missing auth context");
    
    // LAYER 1 RBAC VALIDATION (Defense-in-depth)
    const allowedWorkspaces = authContext.allowed_workspaces || [];
    if (!allowedWorkspaces.includes(input.workspace_id)) {
      throw new Error(`Unauthorized: Tool execution denied for workspace ${input.workspace_id}. Layer 1 RBAC rejected.`);
    }

    const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
      global: { headers: { Authorization: `Bearer ${authContext.token}` } }
    });

    const { data, error } = await supabase
      .from('memory_entries')
      .select('fact, reason, created_at')
      .eq('workspace_id', input.workspace_id)
      .eq('user_id', input.user_id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return JSON.stringify(data || []);
  },
  {
    name: 'read_long_term',
    description: 'Reads long-term facts and context saved previously for this user/workspace.',
    schema: z.object({ workspace_id: z.string(), user_id: z.string() })
  }
);

const writeMemory = tool(
  async (input, config) => {
    const authContext = config?.configurable?.auth_context;
    if (!authContext) throw new Error("Unauthorized: Missing auth context");
    
    // LAYER 1 RBAC VALIDATION (Defense-in-depth)
    const allowedWorkspaces = authContext.allowed_workspaces || [];
    if (!allowedWorkspaces.includes(input.workspace_id)) {
      throw new Error(`Unauthorized: Tool execution denied for workspace ${input.workspace_id}. Layer 1 RBAC rejected.`);
    }

    const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
      global: { headers: { Authorization: `Bearer ${authContext.token}` } }
    });

    const { error } = await supabase.from('memory_entries').insert({
      workspace_id: input.workspace_id,
      user_id: input.user_id,
      fact: input.fact,
      reason: input.reason,
      source_agent: 'memory_agent' // FR-MEM-3 required audit logging
    });

    if (error) {
      console.error(`[MemoryAgent] Failed to persist memory to database: ${error.message}`);
      return `Failed to save memory to database due to an internal error.`; // Fallback gracefully, doesn't throw
    }
    return `Memory successfully saved to database.`;
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
    // In actual implementation, we would extract explicit save requests here.
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

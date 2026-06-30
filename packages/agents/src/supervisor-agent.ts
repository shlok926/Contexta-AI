import { z } from 'zod';
import { BaseAgent } from './base-agent';

export const supervisorAgent: BaseAgent = {
  name: 'Supervisor',
  input_schema: z.object({
    query: z.string()
  }),
  output_schema: z.object({
    route_decision: z.enum(['research', 'direct'])
  }),
  tools: [],
  max_iterations: 1,
  fallback_behavior: async (error, input) => {
    return { route_decision: 'direct' };
  },
  execute: async (input) => {
    // Very simple heuristic for MVP: if it's a greeting, direct. Otherwise, research.
    const lowerQuery = input.query.toLowerCase();
    if (['hi', 'hello', 'hey'].includes(lowerQuery.trim())) {
      return { route_decision: 'direct' };
    }
    return { route_decision: 'research' };
  }
};

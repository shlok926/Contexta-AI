import { z } from 'zod';
import { BaseAgent } from './base-agent';

export const reportAgent: BaseAgent = {
  name: 'Report',
  input_schema: z.object({
    verified_claims: z.array(z.object({
      claim: z.string(),
      verified: z.boolean(),
      source_chunk_id: z.string(),
      match_confidence: z.number()
    }))
  }),
  output_schema: z.object({
    final_answer: z.string()
  }),
  tools: [],
  max_iterations: 1,
  fallback_behavior: async (error, input) => {
    // Citation-or-Decline Policy (Success Path for Uncertainty)
    return { final_answer: "I am unable to provide a verified answer based on the available retrieved context." };
  },
  execute: async (input) => {
    const claims = input.verified_claims || [];

    if (claims.length === 0) {
      return { final_answer: "I am unable to answer this question due to lack of verifiable evidence." };
    }

    // Synthesize final answer with citations
    const citationsText = claims.map((c: any, index: number) => `[${index + 1}]`).join(' ');
    const answer = `Here is the verified answer based on your documents. ${claims.map((c: any) => c.claim).join(' ')} ${citationsText}`;

    return { final_answer: answer };
  }
};

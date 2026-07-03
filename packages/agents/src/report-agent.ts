import { z } from 'zod';
import { BaseAgent } from './base-agent';
import { ChatOpenAI } from '@langchain/openai';
import { REPORT_AGENT_SYSTEM_PROMPT, reportPromptTemplate } from '../../prompts/src/report-agent/v1';
import { REPORT_UNCERTAINTY_SYSTEM_PROMPT, reportUncertaintyPromptTemplate } from '../../prompts/src/report-agent/v1-uncertainty';
import { StringOutputParser } from '@langchain/core/output_parsers';

export const reportAgent: BaseAgent = {
  name: 'Report',
  input_schema: z.object({
    verified_claims: z.array(z.object({
      claim: z.string(),
      verified: z.boolean(),
      source_chunk_id: z.string(),
      match_confidence: z.number()
    })),
    query: z.string()
  }),
  output_schema: z.object({
    final_answer: z.string()
  }),
  tools: [],
  max_iterations: 1,
  fallback_behavior: async (error, input) => {
    return { final_answer: "I am unable to provide a verified answer based on the available retrieved context." };
  },
  execute: async (input) => {
    const claims = input.verified_claims || [];

    const llm = new ChatOpenAI({
      modelName: process.env.MODEL_NAME || 'gpt-4o-mini',
      temperature: 0.2
    });

    let prompt;

    if (claims.length === 0) {
      // Dual-prompt selection logic: Uncertainty path
      prompt = await reportUncertaintyPromptTemplate.format({
        system_prompt: REPORT_UNCERTAINTY_SYSTEM_PROMPT,
        query: input.query
      });
    } else {
      // Dual-prompt selection logic: Answer path
      prompt = await reportPromptTemplate.format({
        system_prompt: REPORT_AGENT_SYSTEM_PROMPT,
        query: input.query,
        claims: JSON.stringify(claims, null, 2)
      });
    }

    const parser = new StringOutputParser();
    const result = await llm.pipe(parser).invoke(prompt);

    return { final_answer: result };
  }
};

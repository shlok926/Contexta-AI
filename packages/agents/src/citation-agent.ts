import { z } from 'zod';
import { BaseAgent } from './base-agent';
import { ChatOpenAI } from '@langchain/openai';
import { CITATION_AGENT_SYSTEM_PROMPT, citationPromptTemplate } from '../../prompts/src/citation-agent/v1';
import { THRESHOLDS } from './config/thresholds';
import { ChatOpenAI } from '@langchain/openai';
import { CITATION_AGENT_SYSTEM_PROMPT, citationPromptTemplate } from '../../prompts/src/citation-agent/v1';
import { getChunkById } from '@contexta/retrieval';

export const citationAgent: BaseAgent = {
  name: 'Citation',
  input_schema: z.object({
    research_findings: z.array(z.object({
      claim: z.string(),
      source_chunk_id: z.string(),
      chunk_content: z.string().optional(),
      confidence: z.number()
    })),
    auth_context: z.any()
  }),
  output_schema: z.object({
    verified_claims: z.array(z.object({
      claim: z.string(),
      verified: z.boolean(),
      source_chunk_id: z.string(),
      match_confidence: z.number()
    })),
    confidence_score: z.number()
  }),
  tools: [],
  max_iterations: 1,
  fallback_behavior: async (error, input) => {
    return { verified_claims: [], confidence_score: 0 };
  },
  execute: async (input) => {
    const findings = input.research_findings || [];
    const authContext = input.auth_context;
    
    if (findings.length === 0) {
      return { verified_claims: [], confidence_score: 0 };
    }

    const claimsWithContext = await Promise.all(
      findings.map(async (finding: any) => {
        const chunk_content = await getChunkById(finding.source_chunk_id, authContext);
        return {
          claim: finding.claim,
          source_chunk_id: finding.source_chunk_id,
          chunk_content: chunk_content || "ERROR: Source chunk not found."
        };
      })
    );

    const llm = new ChatOpenAI({
      modelName: process.env.MODEL_NAME || 'gpt-4o-mini',
      temperature: 0.0
    });

    const structuredLlm = llm.withStructuredOutput(
      z.object({
        verified_claims: z.array(z.object({
          claim: z.string(),
          verified: z.boolean(),
          source_chunk_id: z.string(),
          match_confidence: z.number()
        }))
      }),
      { name: 'verify_claims' }
    );

    const prompt = await citationPromptTemplate.format({
      system_prompt: CITATION_AGENT_SYSTEM_PROMPT,
      findings: JSON.stringify(claimsWithContext, null, 2)
    });

    const result = await structuredLlm.invoke(prompt);

    const verified_claims = result.verified_claims.map((claim: any) => {
      if (claim.match_confidence < THRESHOLDS.CITATION_CONFIDENCE_GATE) {
        claim.verified = false;
      }
      return claim;
    });

    // Exclude unverified claims from final output
    const strictlyVerified = verified_claims.filter((c: any) => c.verified);

    // Aggregate confidence (average of verified claims, or 0 if none)
    const confidence_score = strictlyVerified.length > 0 
      ? strictlyVerified.reduce((acc: number, curr: any) => acc + curr.match_confidence, 0) / strictlyVerified.length 
      : 0;

    return { 
      verified_claims: strictlyVerified,
      confidence_score 
    };
  }
};

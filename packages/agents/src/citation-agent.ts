import { z } from 'zod';
import { BaseAgent } from './base-agent';
import { THRESHOLDS } from './config/thresholds';

export const citationAgent: BaseAgent = {
  name: 'Citation',
  input_schema: z.object({
    research_findings: z.array(z.object({
      claim: z.string(),
      source_chunk_id: z.string(),
      confidence: z.number()
    }))
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
    
    // In reality, this would prompt an LLM to cross-check the claim against the source chunk text.
    // We simulate the verification by checking the confidence from research findings against the gate.
    
    const verified_claims = findings.map((finding: any) => {
      // Simulate verification score
      const match_confidence = finding.confidence;
      const verified = match_confidence >= THRESHOLDS.CITATION_CONFIDENCE_GATE;
      
      return {
        claim: finding.claim,
        verified,
        source_chunk_id: finding.source_chunk_id,
        match_confidence
      };
    });

    // Exclude unverified claims from final output
    const strictlyVerified = verified_claims.filter(c => c.verified);

    // Aggregate confidence (average of verified claims, or 0 if none)
    const confidence_score = strictlyVerified.length > 0 
      ? strictlyVerified.reduce((acc, curr) => acc + curr.match_confidence, 0) / strictlyVerified.length 
      : 0;

    return { 
      verified_claims: strictlyVerified,
      confidence_score 
    };
  }
};

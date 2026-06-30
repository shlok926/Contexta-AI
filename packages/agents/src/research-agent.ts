import { z } from 'zod';
import { BaseAgent } from './base-agent';
import { tool } from '@langchain/core/tools';
import { THRESHOLDS } from './config/thresholds';

// Define the tool with Layer 1 RBAC validation built into its handler
const hybridSearchTool = tool(
  async (input, config) => {
    const authContext = config?.configurable?.auth_context;
    
    // LAYER 1 RBAC VALIDATION
    if (!authContext) {
      throw new Error("Unauthorized: Missing auth context in tool execution");
    }
    
    // We assume auth_context contains allowed_workspaces
    const allowedWorkspaces = authContext.allowed_workspaces || [];
    if (!allowedWorkspaces.includes(input.workspace_id)) {
      throw new Error(`Unauthorized: Tool execution denied for workspace ${input.workspace_id}. Layer 1 RBAC rejected.`);
    }

    // Mock retrieval logic (in real world, hits Supabase with RLS)
    // Here we simulate returning empty if query is unknown or returning mock chunks
    if (input.query.includes('fail')) {
      return JSON.stringify([]);
    }

    return JSON.stringify([
      { id: 'chunk-123', content: 'Enterprise RAG requires strict RBAC.', score: 0.9 },
      { id: 'chunk-456', content: 'The research agent synthesizes findings.', score: 0.85 }
    ]);
  },
  {
    name: 'hybrid_search',
    description: 'Searches the workspace for relevant knowledge using hybrid vector/keyword search.',
    schema: z.object({
      query: z.string().describe("The search query"),
      workspace_id: z.string().describe("The workspace ID to search within"),
    }),
  }
);

export const researchAgent: BaseAgent = {
  name: 'Research',
  input_schema: z.object({
    query: z.string(),
    workspace_scope: z.string(),
    auth_context: z.any()
  }),
  output_schema: z.object({
    findings: z.array(z.object({
      claim: z.string(),
      source_chunk_id: z.string(),
      confidence: z.number()
    }))
  }),
  tools: [hybridSearchTool],
  max_iterations: 2,
  fallback_behavior: async (error, input) => {
    return { findings: [] }; // Explicit "no supporting evidence" fallback
  },
  execute: async (input) => {
    // 1. Invoke the tool
    const searchResultStr = await hybridSearchTool.invoke(
      { query: input.query, workspace_id: input.workspace_scope }, 
      { configurable: { auth_context: input.auth_context } }
    );
    const searchResult = JSON.parse(searchResultStr);

    if (searchResult.length === 0) {
      // Zero chunks retrieved above threshold -> return explicit no evidence
      return { findings: [] };
    }

    // 2. Synthesize findings (mocked LLM generation based on chunks)
    const findings = searchResult.map((res: any) => ({
      claim: `Synthesized claim from ${res.content}`,
      source_chunk_id: res.id,
      confidence: res.score
    }));

    return { findings };
  }
};

import { z } from 'zod';
import { BaseAgent } from './base-agent';
import { ChatOpenAI } from '@langchain/openai';
import { RESEARCH_AGENT_SYSTEM_PROMPT, researchPromptTemplate } from '../../prompts/src/research';
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

    // 1. Initialize RLS-scoped retriever
    const { makeSupabaseRetriever } = await import('../../retrieval/src/index.js');
    const retriever = await makeSupabaseRetriever({ k: 5 } as any, authContext);
    
    // 2. Perform the retrieval
    const documents = await retriever.invoke(input.query);

    // 3. Map LangChain Documents to expected output format
    const chunks = documents.map(doc => ({
      id: doc.metadata?.id || 'unknown-id',
      content: doc.pageContent,
      score: doc.metadata?.score || 1.0
    }));

    return JSON.stringify(chunks);
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
      chunk_content: z.string(),
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

    // 2. Synthesize findings (Real LLM generation based on chunks)
    const llm = new ChatOpenAI({
      modelName: 'gpt-4o-mini', // or configured model
      temperature: 0.1
    });

    const structuredLlm = llm.withStructuredOutput(
      z.object({
        findings: z.array(z.object({
          claim: z.string(),
          source_chunk_id: z.string(),
          chunk_content: z.string(),
          confidence: z.number()
        }))
      }),
      { name: 'synthesize_findings' }
    );

    const prompt = await researchPromptTemplate.format({
      system_prompt: RESEARCH_AGENT_SYSTEM_PROMPT,
      query: input.query,
      context: JSON.stringify(searchResult, null, 2)
    });

    const result = await structuredLlm.invoke(prompt);
    
    return result;
  }
};

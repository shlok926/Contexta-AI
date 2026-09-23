import { StateGraph, START, END } from '@langchain/langgraph';
import { type AgentState, agentStateChannels } from './state';
import { supervisorNode, type SupervisorNodeOptions } from './supervisor/supervisor-node';
import { researchNode, type ResearchNodeOptions, type RunnableConfigLike } from './research/research-node';
import { draftResponseNode, type DraftResponseNodeOptions } from './draft-response/draft-response-node';
import {
  citationVerificationNode,
  type CitationVerificationNodeOptions,
  aggregateVerificationResults,
  type VerificationRouteTarget,
} from './citation-verification';

/**
 * SupervisorEntry Node
 * Evaluates user query and determines routeDecision ('knowledge_query' vs 'direct_conversational').
 */
export async function supervisorEntry(
  state: AgentState,
  config?: RunnableConfigLike,
): Promise<Partial<AgentState>> {
  const supervisorOptions: SupervisorNodeOptions | undefined =
    (config?.configurable as any)?.supervisorOptions ??
    (config?.configurable as any)?.options?.supervisorOptions;

  if (state.routeDecision) {
    return {
      routeDecision: state.routeDecision,
      normalizedQuery: state.normalizedQuery || state.originalQuery || '',
    };
  }
  return await supervisorNode(state, supervisorOptions);
}

/**
 * Route decision conditional edge handler.
 * Routes 'knowledge_query' to ResearchNode, otherwise to DirectAnswer.
 */
export function routeDecision(state: AgentState): 'ResearchNode' | 'DirectAnswer' {
  if (state.routeDecision === 'knowledge_query' || (state as any).route_decision === 'research') {
    return 'ResearchNode';
  }
  return 'DirectAnswer';
}

/**
 * ResearchNode Handler
 * Executes dual dense + sparse retrieval, RRF, cross-encoder reranking.
 */
export async function researchNodeHandler(
  state: AgentState,
  config?: RunnableConfigLike,
): Promise<Partial<AgentState>> {
  const researchOptions: ResearchNodeOptions | undefined =
    (config?.configurable as any)?.researchOptions ??
    (config?.configurable as any)?.options?.researchOptions;
  return await researchNode(state, config, researchOptions);
}

/**
 * DraftResponseNode Handler (N3.7)
 * Synthesizes evidence-grounded draft response, allowlists candidate evidence,
 * assigns deterministic claim IDs, and outputs { draftResponse, extractedClaims }.
 */
export async function draftResponseNodeHandler(
  state: AgentState,
  config?: RunnableConfigLike,
): Promise<Partial<AgentState>> {
  const draftResponseOptions: DraftResponseNodeOptions | undefined =
    (config?.configurable as any)?.draftResponseOptions ??
    (config?.configurable as any)?.options?.draftResponseOptions;
  return await draftResponseNode(state, config, draftResponseOptions);
}

/**
 * CitationNode Handler (N3.8-C6)
 * Executes CitationVerificationNode (Two-Stage Cascade) and computes response-level verification aggregation.
 */
export async function citationNodeHandler(
  state: AgentState,
  config?: RunnableConfigLike,
): Promise<Partial<AgentState>> {
  const citationVerificationOptions: CitationVerificationNodeOptions | undefined =
    (config?.configurable as any)?.citationVerificationOptions ??
    (config?.configurable as any)?.options?.citationVerificationOptions;

  const delta = await citationVerificationNode(state, config, citationVerificationOptions);
  const verificationResults = delta.verificationResults ?? state.verificationResults ?? [];
  const agg = aggregateVerificationResults(verificationResults);

  return {
    verificationResults,
    verificationScore: agg.verificationScore,
  };
}

/**
 * Confidence check conditional edge handler (N3.8-C6).
 * Evaluates response-level aggregation over verificationResults.
 */
export function confidenceCheck(state: AgentState): VerificationRouteTarget {
  const agg = aggregateVerificationResults(state.verificationResults);
  return agg.route;
}

/**
 * ReportNode Handler
 */
export async function reportNodeHandler(state: AgentState): Promise<Partial<AgentState>> {
  if (state.draftResponse) {
    return {
      finalAnswer: state.draftResponse,
      executionStatus: 'completed',
    };
  }
  return {
    finalAnswer: (state as any).final_answer || 'Response generated.',
    executionStatus: 'completed',
  };
}

/**
 * UncertaintyNode Handler
 */
export async function uncertaintyNodeHandler(_state: AgentState): Promise<Partial<AgentState>> {
  return {
    finalAnswer: 'I am unable to provide a verified answer based on the available retrieved context.',
    executionStatus: 'declined_uncertain',
  };
}

/**
 * VerificationFailedNode Handler (N3.8-C6 / ADR-0005 §14)
 * Emits safe operational failure response when verification infrastructure encounters errors.
 */
export async function verificationFailedHandler(_state: AgentState): Promise<Partial<AgentState>> {
  return {
    finalAnswer:
      'Citation verification failed due to a system or provider error. Please try again later.',
    executionStatus: 'failed',
  };
}

/**
 * DirectAnswer Handler
 */
export async function directAnswerHandler(_state: AgentState): Promise<Partial<AgentState>> {
  return {
    finalAnswer: 'Direct conversational answer.',
    executionStatus: 'completed',
  };
}

/**
 * PersistMemory Handler
 */
export async function persistMemoryHandler(_state: AgentState): Promise<Partial<AgentState>> {
  return {};
}

/**
 * Creates the canonical Contexta Agent Graph StateGraph builder.
 */
export function createAgentGraphBuilder() {
  return new StateGraph<AgentState>({
    channels: agentStateChannels,
  })
    .addNode('SupervisorEntry', supervisorEntry)
    .addNode('ResearchNode', researchNodeHandler)
    .addNode('DraftResponseNode', draftResponseNodeHandler)
    .addNode('CitationNode', citationNodeHandler)
    .addNode('ReportNode', reportNodeHandler)
    .addNode('UncertaintyNode', uncertaintyNodeHandler)
    .addNode('VerificationFailedNode', verificationFailedHandler)
    .addNode('DirectAnswer', directAnswerHandler)
    .addNode('PersistMemory', persistMemoryHandler)

    .addEdge(START, 'SupervisorEntry')
    .addConditionalEdges('SupervisorEntry', routeDecision, [
      'ResearchNode',
      'DirectAnswer',
    ])
    .addEdge('ResearchNode', 'DraftResponseNode')
    .addEdge('DraftResponseNode', 'CitationNode')
    .addConditionalEdges('CitationNode', confidenceCheck, [
      'ReportNode',
      'UncertaintyNode',
      'VerificationFailedNode',
    ])
    .addEdge('ReportNode', 'PersistMemory')
    .addEdge('UncertaintyNode', 'PersistMemory')
    .addEdge('VerificationFailedNode', 'PersistMemory')
    .addEdge('DirectAnswer', 'PersistMemory')
    .addEdge('PersistMemory', END);
}

export const builder = createAgentGraphBuilder();

export const graph = builder.compile();

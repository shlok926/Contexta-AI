import { StateGraph, START, END } from '@langchain/langgraph';
import { AgentStateAnnotation } from './state';
// Agent stubs
import { supervisorAgent } from './supervisor-agent';
import { researchAgent } from './research-agent';
import { citationAgent } from './citation-agent';
import { reportAgent } from './report-agent';

// Stubs for the nodes
async function supervisorEntry(state: typeof AgentStateAnnotation.State) {
  // Supervisor agent checks if retrieval is needed
  const response = await supervisorAgent.execute(state);
  return { route_decision: response.route_decision };
}

function routeDecision(state: typeof AgentStateAnnotation.State) {
  if (state.route_decision === 'research') {
    return 'ResearchNode';
  }
  return 'DirectAnswer';
}

async function researchNode(state: typeof AgentStateAnnotation.State) {
  const findings = await researchAgent.execute(state);
  return { research_findings: findings.findings };
}

async function citationNode(state: typeof AgentStateAnnotation.State) {
  const verified = await citationAgent.execute(state);
  return { 
    verified_claims: verified.verified_claims, 
    confidence_score: verified.confidence_score 
  };
}

import { THRESHOLDS } from './config/thresholds';

function confidenceCheck(state: typeof AgentStateAnnotation.State) {
  const threshold = THRESHOLDS.CITATION_CONFIDENCE_GATE;
  if (state.confidence_score >= threshold) {
    return 'ReportNode';
  }
  return 'UncertaintyNode';
}

async function reportNode(state: typeof AgentStateAnnotation.State) {
  const answer = await reportAgent.execute(state);
  return { final_answer: answer.final_answer };
}

async function uncertaintyNode(state: typeof AgentStateAnnotation.State) {
  // constrained mode
  const answer = await reportAgent.fallback_behavior(new Error('Low confidence'), state);
  return { final_answer: answer.final_answer };
}

async function directAnswer(state: typeof AgentStateAnnotation.State) {
  // Direct answer from supervisor context
  return { final_answer: "Direct conversational answer." };
}

async function persistMemory(state: typeof AgentStateAnnotation.State) {
  // Stub for now (Phase 2)
  return {};
}

const builder = new StateGraph(AgentStateAnnotation)
  .addNode('SupervisorEntry', supervisorEntry)
  .addNode('ResearchNode', researchNode)
  .addNode('CitationNode', citationNode)
  .addNode('ReportNode', reportNode)
  .addNode('UncertaintyNode', uncertaintyNode)
  .addNode('DirectAnswer', directAnswer)
  .addNode('PersistMemory', persistMemory)
  
  .addEdge(START, 'SupervisorEntry')
  .addConditionalEdges('SupervisorEntry', routeDecision, [
    'ResearchNode',
    'DirectAnswer'
  ])
  .addEdge('ResearchNode', 'CitationNode')
  .addConditionalEdges('CitationNode', confidenceCheck, [
    'ReportNode',
    'UncertaintyNode'
  ])
  .addEdge('ReportNode', 'PersistMemory')
  .addEdge('UncertaintyNode', 'PersistMemory')
  .addEdge('DirectAnswer', 'PersistMemory')
  .addEdge('PersistMemory', END);

export const graph = builder.compile({
  name: 'ContextaAgentGraph'
});

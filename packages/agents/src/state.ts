import { Annotation } from '@langchain/langgraph';
import { BaseMessage } from '@langchain/core/messages';

export const AgentStateAnnotation = Annotation.Root({
  query: Annotation<string>(),
  workspace_scope: Annotation<string>(), // workspace_id
  auth_context: Annotation<{ user_id: string; roles: string[] }>(),
  research_findings: Annotation<Array<{ claim: string; source_chunk_id: string; confidence: number }>>({
    reducer: (curr, next) => next,
    default: () => [],
  }),
  verified_claims: Annotation<Array<{ claim: string; verified: boolean; source_chunk_id: string; match_confidence: number }>>({
    reducer: (curr, next) => next,
    default: () => [],
  }),
  confidence_score: Annotation<number>({
    reducer: (curr, next) => next,
    default: () => 0,
  }),
  final_answer: Annotation<string>({
    reducer: (curr, next) => next,
    default: () => '',
  }),
  correlation_id: Annotation<string>(),
  route_decision: Annotation<'research' | 'direct'>({
    reducer: (curr, next) => next,
  }),
});

import type { AgentState, RouteDecision, MemoryEntry, ConversationTurn } from '../state';
import {
  SupervisorRouteOutputSchema,
  type SupervisorRouteOutput,
  normalizeQuery,
  evaluateDirectAnswerGuard,
  classifyIntentHeuristic,
  buildSupervisorPrompt,
} from './supervisor-router';

export interface SupervisorRouterInput {
  readonly query: string;
  readonly memories: readonly MemoryEntry[];
  readonly history: readonly ConversationTurn[];
}

export type SupervisorRouterFn = (input: SupervisorRouterInput) => Promise<SupervisorRouteOutput | string>;

export interface SupervisorNodeOptions {
  readonly router?: SupervisorRouterFn;
  readonly llm?: {
    invoke: (messages: any) => Promise<{ content?: string; text?: string } | string>;
  };
}

/**
 * SupervisorNode
 *
 * Intent classification and routing node for Contexta-AI Agent Graph (ADR-0005).
 *
 * Routing Hierarchy:
 * 1. Primary: LLM Structured Semantic Classification (`options.llm`) or injected `options.router`
 * 2. Zod Schema Validation
 * 3. Deterministic Safety Gate: `DirectAnswerGuard` (One-way override direct_conversational -> knowledge_query)
 * 4. Fallback: Deterministic Heuristic Router (`classifyIntentHeuristic`) when neither LLM nor router is configured.
 *
 * Provider Failure Semantics:
 * - On provider timeout/network failure: fails closed to `knowledge_query` with `reason: "routing_safe_fallback_provider_failure: ..."`
 * - On JSON parse / Zod schema validation failure: fails closed to `knowledge_query` with `reason: "routing_safe_fallback_schema_validation_failure: ..."`
 *
 * Invariants:
 * 1. PURE ROUTING: Produces only routeDecision and normalizedQuery state delta.
 * 2. NORMALIZED QUERY OWNERSHIP: Derived deterministically from originalQuery via local normalizeQuery().
 * 3. PROTECTED STATE INTEGRITY: Never mutates or overwrites originalQuery or protected identity fields.
 * 4. CONSERVATIVE SAFETY GATE: DirectAnswerGuard programmatically overrides enterprise queries to knowledge_query.
 * 5. STATELESS & ISOLATED: Operates purely on input state without shared mutable context.
 */
export async function supervisorNode(
  state: AgentState,
  options?: SupervisorNodeOptions,
): Promise<Partial<AgentState>> {
  const originalQuery = state.originalQuery;
  // Local deterministic normalization is authoritative (single producer)
  const normalizedQuery = normalizeQuery(originalQuery);

  let candidateOutput: SupervisorRouteOutput;

  try {
    if (options?.router) {
      // 1. Explicit router function provided (e.g. test fixture or custom LLM adapter)
      const rawResult = await options.router({
        query: originalQuery,
        memories: state.userMemories ?? [],
        history: state.threadHistory ?? [],
      });

      if (typeof rawResult === 'string') {
        try {
          const parsedJson = JSON.parse(rawResult);
          candidateOutput = SupervisorRouteOutputSchema.parse(parsedJson);
        } catch (schemaErr) {
          candidateOutput = {
            intent: 'knowledge_query',
            reason: `routing_safe_fallback_schema_validation_failure: ${schemaErr instanceof Error ? schemaErr.message : String(schemaErr)}`,
          };
        }
      } else {
        try {
          candidateOutput = SupervisorRouteOutputSchema.parse(rawResult);
        } catch (schemaErr) {
          candidateOutput = {
            intent: 'knowledge_query',
            reason: `routing_safe_fallback_schema_validation_failure: ${schemaErr instanceof Error ? schemaErr.message : String(schemaErr)}`,
          };
        }
      }
    } else if (options?.llm) {
      // 2. LangChain Chat Model / LLM provider semantic classification
      const prompt = buildSupervisorPrompt({
        query: originalQuery,
        memories: state.userMemories,
        history: state.threadHistory,
      });

      const response = await options.llm.invoke([
        { role: 'system', content: prompt.systemPrompt },
        { role: 'user', content: prompt.userMessage },
      ]);

      const rawContent = typeof response === 'string' ? response : (response.content || response.text || '');
      // Strip possible markdown code fence wrappers
      const cleanJson = rawContent.replace(/```json\n?|\n?```/g, '').trim();
      
      try {
        const parsedJson = JSON.parse(cleanJson);
        candidateOutput = SupervisorRouteOutputSchema.parse(parsedJson);
      } catch (schemaErr) {
        candidateOutput = {
          intent: 'knowledge_query',
          reason: `routing_safe_fallback_schema_validation_failure: ${schemaErr instanceof Error ? schemaErr.message : String(schemaErr)}`,
        };
      }
    } else {
      // 3. Fallback deterministic heuristic router
      candidateOutput = classifyIntentHeuristic(originalQuery);
    }
  } catch (providerError) {
    // Fail-closed fallback on provider timeout/network failure
    candidateOutput = {
      intent: 'knowledge_query',
      reason: `routing_safe_fallback_provider_failure: ${providerError instanceof Error ? providerError.message : String(providerError)}`,
    };
  }

  // Pass candidate intent through deterministic DirectAnswerGuard (secondary safety layer)
  const guardResult = evaluateDirectAnswerGuard(candidateOutput.intent, originalQuery);

  return {
    routeDecision: guardResult.finalIntent,
    normalizedQuery,
  };
}

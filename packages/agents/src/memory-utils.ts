// Short-term memory eviction rules (FR-MEM-1)

export interface ConversationTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

const MAX_TURNS_BUDGET = 5; // e.g., keep the last 5 turns

export function applyFifoEviction(turns: ConversationTurn[]): ConversationTurn[] {
  // Exception: System/Instruction-level context stays pinned
  const systemTurns = turns.filter(t => t.role === 'system');
  
  // The rest (user/assistant) are subject to FIFO eviction
  const nonSystemTurns = turns.filter(t => t.role !== 'system');
  
  // Oldest first eviction when budget is exceeded
  const retainedNonSystemTurns = nonSystemTurns.slice(-MAX_TURNS_BUDGET);
  
  // Reconstruct the array: system turns first, then the retained non-system turns
  return [...systemTurns, ...retainedNonSystemTurns];
}

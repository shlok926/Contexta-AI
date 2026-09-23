import type { DraftPrompt } from './draft-prompt';
import type { DraftResponse } from './draft-response.schema';

/**
 * Typed exception thrown when the LLM provider fails (network, 5xx, timeout, abort, malformed response).
 */
export class DraftGeneratorInfrastructureException extends Error {
  public readonly code: string = 'DRAFT_GENERATOR_INFRASTRUCTURE_FAILURE';

  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'DraftGeneratorInfrastructureException';
    Object.setPrototypeOf(this, DraftGeneratorInfrastructureException.prototype);
  }
}

export interface DraftGeneratorOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * IDraftGeneratorProvider
 * Framework and provider-agnostic interface for invoking structured draft generation.
 */
export interface IDraftGeneratorProvider {
  generateDraft(
    prompt: DraftPrompt,
    options?: DraftGeneratorOptions,
  ): Promise<DraftResponse>;
}

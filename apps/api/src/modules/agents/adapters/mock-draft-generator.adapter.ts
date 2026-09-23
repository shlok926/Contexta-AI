import { Injectable, Optional } from '@nestjs/common';
import type {
  IDraftGeneratorProvider,
  DraftGeneratorOptions,
  DraftPrompt,
  DraftResponse,
} from '../../../../../../packages/agents/src/index.js';
import {
  DraftGeneratorInfrastructureException,
  validateDraftResponse,
} from '../../../../../../packages/agents/src/index.js';

export interface MockDraftGeneratorOptions {
  readonly customResponse?: DraftResponse | unknown;
  readonly shouldThrow?: boolean;
  readonly throwMessage?: string;
  readonly delayMs?: number;
}

/**
 * MockDraftGeneratorAdapter
 * Deterministic test double for IDraftGeneratorProvider.
 * Used for testing without invoking external LLM providers.
 */
@Injectable()
export class MockDraftGeneratorAdapter implements IDraftGeneratorProvider {
  private customResponse?: DraftResponse | unknown;
  private shouldThrow: boolean;
  private throwMessage: string;
  private delayMs: number;

  constructor(@Optional() options?: MockDraftGeneratorOptions) {
    this.customResponse = options?.customResponse;
    this.shouldThrow = options?.shouldThrow ?? false;
    this.throwMessage = options?.throwMessage ?? 'Simulated provider failure';
    this.delayMs = options?.delayMs ?? 0;
  }

  setResponse(response: DraftResponse | unknown): void {
    this.customResponse = response;
  }

  setFailure(shouldThrow: boolean, message = 'Simulated provider failure'): void {
    this.shouldThrow = shouldThrow;
    this.throwMessage = message;
  }

  async generateDraft(
    prompt: DraftPrompt,
    options?: DraftGeneratorOptions,
  ): Promise<DraftResponse> {
    if (options?.signal?.aborted) {
      throw new DraftGeneratorInfrastructureException('Draft generation aborted by signal');
    }

    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), this.delayMs);
        if (options?.signal) {
          options.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new DraftGeneratorInfrastructureException('Draft generation aborted by signal'));
            },
            { once: true },
          );
        }
      });
    }

    if (this.shouldThrow) {
      throw new DraftGeneratorInfrastructureException(this.throwMessage);
    }

    if (this.customResponse !== undefined) {
      try {
        return validateDraftResponse(this.customResponse);
      } catch (err) {
        throw new DraftGeneratorInfrastructureException(
          'Draft generation failed: Model output schema validation failed',
          err,
        );
      }
    }

    // Default mock behavior: synthesize deterministic draft from prompt
    const defaultResponse: DraftResponse = {
      answer: 'Synthesized response based on provided evidence.',
      extractedClaims: [
        {
          claimId: 'claim_mock_0',
          claimText: 'Synthesized response based on provided evidence.',
          citedChunkIds: ['chunk-101'],
        },
      ],
    };

    return validateDraftResponse(defaultResponse);
  }
}

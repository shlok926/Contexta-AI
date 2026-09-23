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

export interface OpenAIDraftGeneratorAdapterOptions {
  readonly apiKey?: string;
  readonly modelName?: string;
  readonly timeoutMs?: number;
  readonly baseUrl?: string;
}

/**
 * OpenAIDraftGeneratorAdapter
 * Implements IDraftGeneratorProvider to invoke OpenAI chat completions with structured JSON format.
 * Enforces Zod validation, AbortSignal timeout propagation, and strict credential isolation.
 */
@Injectable()
export class OpenAIDraftGeneratorAdapter implements IDraftGeneratorProvider {
  private readonly apiKey: string;
  private readonly modelName: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(@Optional() options?: OpenAIDraftGeneratorAdapterOptions) {
    this.apiKey = options?.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.modelName =
      options?.modelName ??
      process.env.DRAFT_RESPONSE_MODEL ??
      'gpt-4o-mini';
    this.timeoutMs = options?.timeoutMs ?? 5000;
    this.baseUrl = (options?.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  }

  async generateDraft(
    prompt: DraftPrompt,
    options?: DraftGeneratorOptions,
  ): Promise<DraftResponse> {
    if (options?.signal?.aborted) {
      throw new DraftGeneratorInfrastructureException('Draft generation aborted by signal');
    }

    const effectiveTimeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    let timeoutId: NodeJS.Timeout | undefined;

    if (effectiveTimeoutMs > 0) {
      timeoutId = setTimeout(() => {
        controller.abort(new Error(`Draft generation timed out after ${effectiveTimeoutMs}ms`));
      }, effectiveTimeoutMs);
    }

    if (options?.signal) {
      options.signal.addEventListener(
        'abort',
        () => controller.abort(options.signal?.reason),
        { once: true },
      );
    }

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.modelName,
          messages: [
            { role: 'system', content: prompt.systemPrompt },
            { role: 'user', content: prompt.userMessage },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.0,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        // Sanitize error text to strip potential API keys or tokens
        const sanitized = errorText.replace(/Bearer\s+[A-Za-z0-9-_.]+/gi, '[REDACTED]');
        throw new DraftGeneratorInfrastructureException(
          `OpenAI chat completion failed with status ${response.status}: ${sanitized}`,
        );
      }

      const payload = (await response.json()) as {
        choices?: Array<{
          message?: {
            content?: string;
          };
        }>;
      };

      const rawContent = payload.choices?.[0]?.message?.content;
      if (!rawContent || rawContent.trim().length === 0) {
        throw new DraftGeneratorInfrastructureException(
          'Draft generation failed: Empty or missing message content in model response',
        );
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawContent);
      } catch (parseErr) {
        throw new DraftGeneratorInfrastructureException(
          `Draft generation failed: Malformed JSON output from model`,
          parseErr,
        );
      }

      try {
        return validateDraftResponse(parsedJson);
      } catch (validationErr) {
        throw new DraftGeneratorInfrastructureException(
          `Draft generation failed: Model output schema validation failed`,
          validationErr,
        );
      }
    } catch (err: unknown) {
      if (err instanceof DraftGeneratorInfrastructureException) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new DraftGeneratorInfrastructureException(
        `Draft generation provider failure: ${message}`,
        err,
      );
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }
}

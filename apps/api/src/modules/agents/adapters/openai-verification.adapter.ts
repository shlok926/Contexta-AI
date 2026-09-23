import { Injectable, Optional } from '@nestjs/common';
import type {
  IVerificationProvider,
  VerificationProviderOptions,
  VerificationRequest,
  VerificationProviderResponse,
} from '../../../../../../packages/agents/src/index.js';
import {
  VerificationInfrastructureException,
  validateVerificationProviderResponse,
  buildVerificationPrompt,
} from '../../../../../../packages/agents/src/index.js';

export interface OpenAIVerificationAdapterOptions {
  readonly apiKey?: string;
  readonly modelName?: string;
  readonly timeoutMs?: number;
  readonly baseUrl?: string;
}

/**
 * OpenAIVerificationAdapter
 * Implements IVerificationProvider to invoke OpenAI chat completions with structured JSON output.
 * Enforces Zod schema validation, closed-universe citation validation, AbortSignal timeouts, and credential isolation.
 */
@Injectable()
export class OpenAIVerificationAdapter implements IVerificationProvider {
  private readonly apiKey: string;
  private readonly modelName: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(@Optional() options?: OpenAIVerificationAdapterOptions) {
    this.apiKey = options?.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.modelName =
      options?.modelName ??
      process.env.CITATION_VERIFICATION_MODEL ??
      'gpt-4o-mini';
    this.timeoutMs = options?.timeoutMs ?? 5000;
    this.baseUrl = (options?.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  }

  async verify(
    request: VerificationRequest,
    options?: VerificationProviderOptions,
  ): Promise<VerificationProviderResponse> {
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      throw new VerificationInfrastructureException('Verification provider configuration error: Missing API key');
    }

    if (options?.signal?.aborted) {
      throw new VerificationInfrastructureException('Citation verification aborted by signal');
    }

    const effectiveTimeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    let timeoutId: NodeJS.Timeout | undefined;

    if (effectiveTimeoutMs > 0) {
      timeoutId = setTimeout(() => {
        controller.abort(new Error(`Citation verification timed out after ${effectiveTimeoutMs}ms`));
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
      const prompt = buildVerificationPrompt(request);

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
        // Sanitize error text to strip potential API keys, authorization headers or tokens
        const sanitized = errorText
          .replace(/Bearer\s+[A-Za-z0-9-_.]+/gi, '[REDACTED]')
          .replace(/key=[A-Za-z0-9-_.]+/gi, 'key=[REDACTED]');
        throw new VerificationInfrastructureException(
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
        throw new VerificationInfrastructureException(
          'Verification provider failure: Empty or missing message content in model response',
        );
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawContent);
      } catch (parseErr) {
        throw new VerificationInfrastructureException(
          'Verification provider failure: Malformed JSON output from model',
          parseErr,
        );
      }

      let validatedResponse: VerificationProviderResponse;
      try {
        validatedResponse = validateVerificationProviderResponse(parsedJson);
      } catch (validationErr) {
        throw new VerificationInfrastructureException(
          'Verification provider failure: Model output schema validation failed',
          validationErr,
        );
      }

      // Semantic closed-universe integrity validation
      this.validateClosedUniverseIntegrity(request, validatedResponse);

      return validatedResponse;
    } catch (err: unknown) {
      if (err instanceof VerificationInfrastructureException) {
        throw err;
      }
      const isAbort = (err as { name?: string })?.name === 'AbortError' || controller.signal.aborted;
      if (isAbort) {
        throw new VerificationInfrastructureException('Citation verification aborted or timed out', err);
      }
      const rawMessage = err instanceof Error ? err.message : String(err);
      const sanitizedMessage = rawMessage
        .replace(/Bearer\s+[A-Za-z0-9-_.]+/gi, '[REDACTED]')
        .replace(/key=[A-Za-z0-9-_.]+/gi, 'key=[REDACTED]');
      throw new VerificationInfrastructureException(
        `Verification provider failure: ${sanitizedMessage}`,
        err,
      );
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Enforces closed-universe citation integrity and claim ID consistency.
   * Rejects any hallucinated claim IDs, foreign chunk IDs, or duplicate evaluations.
   */
  private validateClosedUniverseIntegrity(
    request: VerificationRequest,
    response: VerificationProviderResponse,
  ): void {
    const validClaimIds = new Set(request.claims.map((c) => c.claimId));
    const validCandidateChunkIds = new Set(request.candidateEvidence.map((e) => e.chunkId));
    const seenClaimIds = new Set<string>();

    for (const evaluation of response.evaluations) {
      if (!validClaimIds.has(evaluation.claimId)) {
        throw new VerificationInfrastructureException(
          `Verification provider failure: Unknown claimId "${evaluation.claimId}" not present in input claims`,
        );
      }

      if (seenClaimIds.has(evaluation.claimId)) {
        throw new VerificationInfrastructureException(
          `Verification provider failure: Duplicate evaluation for claimId "${evaluation.claimId}"`,
        );
      }
      seenClaimIds.add(evaluation.claimId);

      for (const chunkId of evaluation.citedChunkIds) {
        if (!validCandidateChunkIds.has(chunkId)) {
          throw new VerificationInfrastructureException(
            `Verification provider failure: Unknown citedChunkId "${chunkId}" violates closed evidence universe`,
          );
        }
      }

      if (evaluation.conflictingChunkIds) {
        for (const chunkId of evaluation.conflictingChunkIds) {
          if (!validCandidateChunkIds.has(chunkId)) {
            throw new VerificationInfrastructureException(
              `Verification provider failure: Unknown conflictingChunkId "${chunkId}" violates closed evidence universe`,
            );
          }
        }
      }
    }
  }
}

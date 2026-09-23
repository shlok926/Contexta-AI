import { Injectable, Optional } from '@nestjs/common';
import type {
  IEmbeddingProvider,
  EmbeddingOptions,
} from '../../../../../../packages/agents/src/research/embedding.interface.js';

export interface OpenAIEmbeddingAdapterOptions {
  readonly apiKey?: string;
  readonly modelName?: string;
  readonly dimensions?: number;
  readonly baseUrl?: string;
}

/**
 * OpenAIEmbeddingAdapter
 * Implements IEmbeddingProvider for generating 1536-dim query embeddings.
 * Uses native fetch with AbortSignal support, dimension validation, and fail-closed security.
 */
@Injectable()
export class OpenAIEmbeddingAdapter implements IEmbeddingProvider {
  private readonly apiKey: string;
  private readonly modelName: string;
  private readonly expectedDimensions: number;
  private readonly baseUrl: string;

  constructor(@Optional() options?: OpenAIEmbeddingAdapterOptions) {

    this.apiKey = options?.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.modelName =
      options?.modelName ??
      process.env.RETRIEVAL_EMBEDDING_MODEL ??
      'text-embedding-3-small';
    this.expectedDimensions = options?.dimensions ?? 1536;
    this.baseUrl = (options?.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  }

  async generateQueryEmbedding(
    query: string,
    options?: EmbeddingOptions,
  ): Promise<readonly number[]> {
    if (!query || query.trim().length === 0) {
      throw new Error('Embedding generation failed: Query string cannot be empty');
    }

    if (options?.signal?.aborted) {
      throw new Error('Embedding generation aborted by signal');
    }

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input: query,
        model: this.modelName,
        dimensions: this.expectedDimensions,
      }),
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `OpenAI embedding API failed with status ${response.status}: ${errorText}`,
      );
    }

    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };

    const embedding = payload.data?.[0]?.embedding;
    if (!embedding || !Array.isArray(embedding)) {
      throw new Error('Embedding generation failed: Missing embedding in API response');
    }

    if (embedding.length !== this.expectedDimensions) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.expectedDimensions}, received ${embedding.length}`,
      );
    }

    return embedding;
  }
}

import { Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  IRetrievalAdapter,
  DenseChunkCandidate,
  SparseChunkCandidate,
  DenseSearchOptions,
  SparseSearchOptions,
} from '../../../../../../packages/agents/src/research/retrieval.interface.js';

/**
 * SupabaseRetrievalAdapter
 * Implements IRetrievalAdapter by executing PostgreSQL RPCs:
 * - match_workspace_dense_chunks (pgvector HNSW cosine distance + canonical visibility)
 * - match_workspace_sparse_chunks (PostgreSQL FTS websearch_to_tsquery + canonical visibility)
 *
 * Security & Tenancy:
 * - Executes as SECURITY INVOKER under the authenticated caller's JWT.
 * - workspace_id filters candidate search space.
 * - RLS independently enforces data boundaries against auth.uid().
 */
@Injectable()
export class SupabaseRetrievalAdapter implements IRetrievalAdapter {
  constructor(private readonly supabaseClient: SupabaseClient) {}

  async searchDense(
    workspaceId: string,
    queryEmbedding: readonly number[],
    options?: DenseSearchOptions,
  ): Promise<readonly DenseChunkCandidate[]> {
    const matchThreshold = options?.matchThreshold ?? 0.3;
    const matchCount = options?.matchCount ?? 60;
    const maxScanTuples = options?.maxScanTuples ?? 20000;

    let rpcCall = this.supabaseClient.rpc('match_workspace_dense_chunks', {
      p_query_embedding: queryEmbedding as number[],
      p_match_threshold: matchThreshold,
      p_match_count: matchCount,
      p_workspace_id: workspaceId,
      p_max_scan_tuples: maxScanTuples,
    });

    if (options?.signal) {
      rpcCall = rpcCall.abortSignal(options.signal);
    }

    const { data, error } = await rpcCall;

    if (error) {
      throw new Error(`Dense retrieval RPC failed: ${error.message}`);
    }

    if (!data || !Array.isArray(data)) {
      return [];
    }

    return data.map((row: any) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      documentVersionId: row.document_version_id,
      chunkOffset: Number(row.chunk_offset),
      content: row.content,
      similarity: Number(row.similarity),
      documentTitle: row.document_title,
      sourceType: row.source_type,
    }));
  }

  async searchSparse(
    workspaceId: string,
    queryText: string,
    options?: SparseSearchOptions,
  ): Promise<readonly SparseChunkCandidate[]> {
    const matchCount = options?.matchCount ?? 60;

    let rpcCall = this.supabaseClient.rpc('match_workspace_sparse_chunks', {
      p_query_text: queryText,
      p_match_count: matchCount,
      p_workspace_id: workspaceId,
    });

    if (options?.signal) {
      rpcCall = rpcCall.abortSignal(options.signal);
    }

    const { data, error } = await rpcCall;

    if (error) {
      throw new Error(`Sparse retrieval RPC failed: ${error.message}`);
    }

    if (!data || !Array.isArray(data)) {
      return [];
    }

    return data.map((row: any) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      documentVersionId: row.document_version_id,
      chunkOffset: Number(row.chunk_offset),
      content: row.content,
      rankScore: Number(row.rank_score),
      documentTitle: row.document_title,
      sourceType: row.source_type,
    }));
  }
}

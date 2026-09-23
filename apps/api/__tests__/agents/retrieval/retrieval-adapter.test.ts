import { jest } from '@jest/globals';
import { SupabaseRetrievalAdapter } from '../../../src/modules/agents/adapters/supabase-retrieval.adapter.js';
import type { SupabaseClient } from '@supabase/supabase-js';


describe('SupabaseRetrievalAdapter', () => {
  const workspaceId = '110e8400-e29b-41d4-a716-446655440000';
  const mockQueryEmbedding = new Array(1536).fill(0.05);

  let mockSupabaseClient: jest.Mocked<Partial<SupabaseClient>>;
  let mockRpcQuery: any;

  beforeEach(() => {
    mockRpcQuery = {
      abortSignal: jest.fn().mockReturnThis(),
      then: jest.fn(),
    };

    mockSupabaseClient = {
      rpc: jest.fn().mockReturnValue(mockRpcQuery),
    } as any;
  });

  describe('searchDense', () => {
    it('invokes match_workspace_dense_chunks with correct parameters and maps results', async () => {
      const mockRows = [
        {
          chunk_id: 'c-1',
          document_id: 'd-1',
          document_version_id: 'v-1',
          chunk_offset: 0,
          content: 'Dense chunk content 1',
          similarity: 0.91,
          document_title: 'Doc Title 1',
          source_type: 'pdf',
        },
      ];

      // Simulate successful RPC response
      mockRpcQuery.then.mockImplementation((resolve: any) =>
        resolve({ data: mockRows, error: null }),
      );

      const adapter = new SupabaseRetrievalAdapter(mockSupabaseClient as unknown as SupabaseClient);

      const results = await adapter.searchDense(workspaceId, mockQueryEmbedding, {
        matchThreshold: 0.35,
        matchCount: 30,
        maxScanTuples: 15000,
      });

      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith('match_workspace_dense_chunks', {
        p_query_embedding: mockQueryEmbedding,
        p_match_threshold: 0.35,
        p_match_count: 30,
        p_workspace_id: workspaceId,
        p_max_scan_tuples: 15000,
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        chunkId: 'c-1',
        documentId: 'd-1',
        documentVersionId: 'v-1',
        chunkOffset: 0,
        content: 'Dense chunk content 1',
        similarity: 0.91,
        documentTitle: 'Doc Title 1',
        sourceType: 'pdf',
      });
    });

    it('propagates AbortSignal to dense RPC query', async () => {
      const controller = new AbortController();
      mockRpcQuery.then.mockImplementation((resolve: any) =>
        resolve({ data: [], error: null }),
      );

      const adapter = new SupabaseRetrievalAdapter(mockSupabaseClient as unknown as SupabaseClient);

      await adapter.searchDense(workspaceId, mockQueryEmbedding, {
        signal: controller.signal,
      });

      expect(mockRpcQuery.abortSignal).toHaveBeenCalledWith(controller.signal);
    });

    it('throws error when dense RPC fails', async () => {
      mockRpcQuery.then.mockImplementation((resolve: any) =>
        resolve({ data: null, error: { message: 'Database connection failed' } }),
      );

      const adapter = new SupabaseRetrievalAdapter(mockSupabaseClient as unknown as SupabaseClient);

      await expect(
        adapter.searchDense(workspaceId, mockQueryEmbedding),
      ).rejects.toThrow('Dense retrieval RPC failed: Database connection failed');
    });
  });

  describe('searchSparse', () => {
    it('invokes match_workspace_sparse_chunks with correct parameters and maps results', async () => {
      const mockRows = [
        {
          chunk_id: 'c-2',
          document_id: 'd-2',
          document_version_id: 'v-2',
          chunk_offset: 2,
          content: 'Sparse chunk content 2',
          rank_score: 0.82,
          document_title: 'Doc Title 2',
          source_type: 'txt',
        },
      ];

      mockRpcQuery.then.mockImplementation((resolve: any) =>
        resolve({ data: mockRows, error: null }),
      );

      const adapter = new SupabaseRetrievalAdapter(mockSupabaseClient as unknown as SupabaseClient);

      const results = await adapter.searchSparse(workspaceId, 'authentication tokens', {
        matchCount: 40,
      });

      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith('match_workspace_sparse_chunks', {
        p_query_text: 'authentication tokens',
        p_match_count: 40,
        p_workspace_id: workspaceId,
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        chunkId: 'c-2',
        documentId: 'd-2',
        documentVersionId: 'v-2',
        chunkOffset: 2,
        content: 'Sparse chunk content 2',
        rankScore: 0.82,
        documentTitle: 'Doc Title 2',
        sourceType: 'txt',
      });
    });

    it('returns empty array when RPC returns null data', async () => {
      mockRpcQuery.then.mockImplementation((resolve: any) =>
        resolve({ data: null, error: null }),
      );

      const adapter = new SupabaseRetrievalAdapter(mockSupabaseClient as unknown as SupabaseClient);

      const results = await adapter.searchSparse(workspaceId, 'stopword');
      expect(results).toEqual([]);
    });

    it('throws error when sparse RPC fails', async () => {
      mockRpcQuery.then.mockImplementation((resolve: any) =>
        resolve({ data: null, error: { message: 'Query syntax error' } }),
      );

      const adapter = new SupabaseRetrievalAdapter(mockSupabaseClient as unknown as SupabaseClient);

      await expect(
        adapter.searchSparse(workspaceId, 'test query'),
      ).rejects.toThrow('Sparse retrieval RPC failed: Query syntax error');
    });
  });
});

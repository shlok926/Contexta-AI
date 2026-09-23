-- ============================================================================
-- Migration: 20260922000001_phase3_hybrid_retrieval.sql
-- Description: N3.6 Hybrid Retrieval RPC Functions (Dense Vector & Sparse FTS)
-- Governing ADRs: ADR-0002 (Vector Tenancy Isolation), ADR-0007 (Canonical Schema),
--                 ADR-0009 (Ingestion & Retrieval Architecture)
-- Frozen Baselines Preserved: 20260912000000_canonical_15_entity_baseline.sql,
--                             20260921000001_phase3_agent_run_persistence.sql
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Dense Semantic Vector Search RPC: match_workspace_dense_chunks
-- Executes Cosine Distance (<=>) vector search over embeddings table,
-- joined against canonical chunks, document_versions, and documents.
-- Enforces:
--   - Tenant isolation via workspace_id B-Tree filter and RLS (SECURITY INVOKER)
--   - Canonical visibility: is_deleted = false, status = 'ready', is_current = true, is_superseded = false
--   - Iterative HNSW index scanning with configurable scan tuple budget
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.match_workspace_dense_chunks(
    p_query_embedding VECTOR(1536),
    p_match_threshold FLOAT,
    p_match_count INT,
    p_workspace_id UUID,
    p_max_scan_tuples INT DEFAULT 20000
)
RETURNS TABLE (
    chunk_id UUID,
    document_id UUID,
    document_version_id UUID,
    chunk_offset INT,
    content TEXT,
    similarity FLOAT,
    document_title VARCHAR,
    source_type VARCHAR
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    -- Configure iterative scan GUCs locally for this transaction
    PERFORM set_config('hnsw.iterative_scan', 'strict_order', true);
    PERFORM set_config('hnsw.max_scan_tuples', p_max_scan_tuples::text, true);

    -- Visibility-aware dense vector query
    -- Under pgvector iterative_scan = strict_order, candidate evaluation traverses the HNSW
    -- index and applies visibility predicates until p_match_count valid items are collected
    -- or the p_max_scan_tuples budget is reached.
    RETURN QUERY
    SELECT
        c.id AS chunk_id,
        dv.document_id AS document_id,
        dv.id AS document_version_id,
        c.chunk_offset AS chunk_offset,
        c.content AS content,
        (1 - (e.embedding_vector <=> p_query_embedding))::FLOAT AS similarity,
        d.title AS document_title,
        d.source_type AS source_type
    FROM public.embeddings e
    JOIN public.chunks c ON e.chunk_id = c.id
    JOIN public.document_versions dv ON c.document_version_id = dv.id
    JOIN public.documents d ON dv.document_id = d.id
    WHERE e.workspace_id = p_workspace_id
      AND c.workspace_id = p_workspace_id
      AND dv.workspace_id = p_workspace_id
      AND d.workspace_id = p_workspace_id
      AND d.is_deleted = false
      AND dv.status = 'ready'
      AND dv.is_current = true
      AND dv.is_superseded = false
      AND (1 - (e.embedding_vector <=> p_query_embedding)) >= p_match_threshold
    ORDER BY (e.embedding_vector <=> p_query_embedding) ASC, c.id ASC
    LIMIT p_match_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.match_workspace_dense_chunks(VECTOR(1536), FLOAT, INT, UUID, INT) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_workspace_dense_chunks(VECTOR(1536), FLOAT, INT, UUID, INT) TO authenticated;

-- ----------------------------------------------------------------------------
-- 2. Sparse Full-Text Search RPC: match_workspace_sparse_chunks
-- Executes PostgreSQL Full-Text Search with websearch_to_tsquery over chunks.tsv_content,
-- scored via ts_rank_cd cover density ranking.
-- Enforces:
--   - Tenant isolation via workspace_id B-Tree filter and RLS (SECURITY INVOKER)
--   - Canonical visibility: is_deleted = false, status = 'ready', is_current = true, is_superseded = false
--   - Graceful empty return on stopword / empty tsquery
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.match_workspace_sparse_chunks(
    p_query_text TEXT,
    p_match_count INT,
    p_workspace_id UUID
)
RETURNS TABLE (
    chunk_id UUID,
    document_id UUID,
    document_version_id UUID,
    chunk_offset INT,
    content TEXT,
    rank_score FLOAT,
    document_title VARCHAR,
    source_type VARCHAR
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_tsquery TSQUERY;
BEGIN
    v_tsquery := websearch_to_tsquery('english', p_query_text);
    
    IF v_tsquery IS NULL OR v_tsquery = ''::tsquery THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        c.id AS chunk_id,
        dv.document_id AS document_id,
        dv.id AS document_version_id,
        c.chunk_offset AS chunk_offset,
        c.content AS content,
        ts_rank_cd(c.tsv_content, v_tsquery, 32)::FLOAT AS rank_score,
        d.title AS document_title,
        d.source_type AS source_type
    FROM public.chunks c
    JOIN public.document_versions dv ON c.document_version_id = dv.id
    JOIN public.documents d ON dv.document_id = d.id
    WHERE c.workspace_id = p_workspace_id
      AND dv.workspace_id = p_workspace_id
      AND d.workspace_id = p_workspace_id
      AND d.is_deleted = false
      AND dv.status = 'ready'
      AND dv.is_current = true
      AND dv.is_superseded = false
      AND c.tsv_content @@ v_tsquery
    ORDER BY rank_score DESC, c.id ASC
    LIMIT p_match_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.match_workspace_sparse_chunks(TEXT, INT, UUID) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_workspace_sparse_chunks(TEXT, INT, UUID) TO authenticated;

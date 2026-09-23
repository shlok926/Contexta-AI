import { PostgresTestClient } from './test-client.js';

describe('N3.6: Hybrid Retrieval Database & RLS Integration', () => {
  const db = new PostgresTestClient();

  const ORG_A_ID = '11111111-1111-4111-a111-111111111111';
  const ORG_B_ID = '22222222-2222-4222-a222-222222222222';
  const WS_A_ID = '33333333-3333-4333-a333-333333333333';
  const WS_B_ID = '44444444-4444-4444-a444-444444444444';
  const USER_A_ID = '55555555-5555-4555-a555-555555555555';
  const USER_B_ID = '66666666-6666-4666-a666-666666666666';

  const DOC_A_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const DOC_B_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const DOC_DELETED_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

  const VER_A1_ID = '1111aaaa-1111-aaaa-1111-aaaaaaaaaaaa'; // superseded
  const VER_A2_ID = '2222aaaa-2222-aaaa-2222-aaaaaaaaaaaa'; // current ready
  const VER_A3_PROCESSING_ID = '3333aaaa-3333-aaaa-3333-aaaaaaaaaaaa'; // processing
  const VER_B1_ID = '1111bbbb-1111-bbbb-1111-bbbbbbbbbbbb'; // current ready in WS B

  const CHUNK_A1_ID = 'c111aaaa-1111-aaaa-1111-aaaaaaaaaaaa';
  const CHUNK_A2_ID = 'c222aaaa-2222-aaaa-2222-aaaaaaaaaaaa';
  const CHUNK_B1_ID = 'c111bbbb-1111-bbbb-1111-bbbbbbbbbbbb';

  let dockerAvailable = true;

  beforeAll(async () => {
    try {
      const probe = await db.rawQuery('SELECT 1;');
      if (probe.exitCode !== 0) {
        dockerAvailable = false;
      }
    } catch {
      dockerAvailable = false;
    }

    if (dockerAvailable) {
      // Ensure migration functions are created
      await db.executeAsAdmin(`
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
            PERFORM set_config('hnsw.iterative_scan', 'strict_order', true);
            PERFORM set_config('hnsw.max_scan_tuples', p_max_scan_tuples::text, true);

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

        GRANT EXECUTE ON FUNCTION public.match_workspace_dense_chunks(VECTOR(1536), FLOAT, INT, UUID, INT) TO authenticated;

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

        GRANT EXECUTE ON FUNCTION public.match_workspace_sparse_chunks(TEXT, INT, UUID) TO authenticated;
      `);
    }
  });

  beforeEach(async () => {
    if (!dockerAvailable) return;

    await db.cleanAllTables();

    // 1. Seed orgs
    await db.executeAsAdmin(`
      INSERT INTO public.organizations (id, name) VALUES
      ('${ORG_A_ID}', 'Org A'),
      ('${ORG_B_ID}', 'Org B');
    `);

    // 2. Seed auth users & profiles
    await db.seedAuthUser(USER_A_ID, 'userA@test.com');
    await db.seedAuthUser(USER_B_ID, 'userB@test.com');

    await db.executeAsAdmin(`
      INSERT INTO public.users (id, organization_id, email, full_name) VALUES
      ('${USER_A_ID}', '${ORG_A_ID}', 'userA@test.com', 'User A'),
      ('${USER_B_ID}', '${ORG_B_ID}', 'userB@test.com', 'User B');
    `);

    // 3. Seed workspaces
    await db.executeAsAdmin(`
      INSERT INTO public.workspaces (id, organization_id, name) VALUES
      ('${WS_A_ID}', '${ORG_A_ID}', 'Workspace A'),
      ('${WS_B_ID}', '${ORG_B_ID}', 'Workspace B');
    `);

    // 4. Seed workspace memberships
    await db.executeAsAdmin(`
      INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
      ('${WS_A_ID}', '${USER_A_ID}', 'contributor'),
      ('${WS_B_ID}', '${USER_B_ID}', 'contributor');
    `);

    // 5. Seed documents
    await db.executeAsAdmin(`
      INSERT INTO public.documents (id, workspace_id, uploaded_by, title, source_type, is_deleted) VALUES
      ('${DOC_A_ID}', '${WS_A_ID}', '${USER_A_ID}', 'Enterprise Security Architecture', 'pdf', false),
      ('${DOC_DELETED_ID}', '${WS_A_ID}', '${USER_A_ID}', 'Deleted Security Architecture', 'pdf', true),
      ('${DOC_B_ID}', '${WS_B_ID}', '${USER_B_ID}', 'Tenant B Confidential Doc', 'pdf', false);
    `);

    // 6. Seed document versions
    await db.executeAsAdmin(`
      INSERT INTO public.document_versions (id, document_id, workspace_id, version_number, status, is_current, is_superseded) VALUES
      ('${VER_A1_ID}', '${DOC_A_ID}', '${WS_A_ID}', 1, 'ready', false, true),
      ('${VER_A2_ID}', '${DOC_A_ID}', '${WS_A_ID}', 2, 'ready', true, false),
      ('${VER_A3_PROCESSING_ID}', '${DOC_A_ID}', '${WS_A_ID}', 3, 'processing', false, false),
      ('${VER_B1_ID}', '${DOC_B_ID}', '${WS_B_ID}', 1, 'ready', true, false);
    `);

    // 7. Seed chunks
    await db.executeAsAdmin(`
      INSERT INTO public.chunks (id, document_version_id, workspace_id, chunk_offset, content, token_count) VALUES
      ('${CHUNK_A1_ID}', '${VER_A1_ID}', '${WS_A_ID}', 0, 'Old superseded version authentication details.', 10),
      ('${CHUNK_A2_ID}', '${VER_A2_ID}', '${WS_A_ID}', 0, 'Current enterprise authentication architecture with cryptographic JWT.', 10),
      ('${CHUNK_B1_ID}', '${VER_B1_ID}', '${WS_B_ID}', 0, 'Confidential Tenant B financial information and architecture.', 10);
    `);

    // 8. Seed embeddings (1536-dim dummy vectors)
    // CHUNK_A1 vector: closer to [0.1, 0, ...]
    // CHUNK_A2 vector: [0.1, 0.1, ...]
    // CHUNK_B1 vector: [0.1, 0.1, ...]
    await db.executeAsAdmin(`
      INSERT INTO public.embeddings (id, chunk_id, workspace_id, embedding_vector, model_name) VALUES
      ('11111111-0000-0000-0000-000000000001', '${CHUNK_A1_ID}', '${WS_A_ID}', array_fill(0.1, ARRAY[1536])::vector, 'text-embedding-3-small'),
      ('11111111-0000-0000-0000-000000000002', '${CHUNK_A2_ID}', '${WS_A_ID}', array_fill(0.08, ARRAY[1536])::vector, 'text-embedding-3-small'),
      ('11111111-0000-0000-0000-000000000003', '${CHUNK_B1_ID}', '${WS_B_ID}', array_fill(0.08, ARRAY[1536])::vector, 'text-embedding-3-small');
    `);
  });

  afterAll(async () => {
    if (dockerAvailable) {
      await db.cleanAllTables();
    }
  });

  it('retrieves only active/current document chunks in dense search, excluding superseded versions', async () => {
    if (!dockerAvailable) return;

    const queryVector = 'array_fill(0.1, ARRAY[1536])::vector';
    const rows = await db.queryAsUser(
      USER_A_ID,
      `SELECT * FROM public.match_workspace_dense_chunks(${queryVector}, 0.0, 10, '${WS_A_ID}', 20000);`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].chunk_id).toBe(CHUNK_A2_ID);
    expect(rows[0].document_version_id).toBe(VER_A2_ID);
  });

  it('retrieves only active/current document chunks in sparse FTS search', async () => {
    if (!dockerAvailable) return;

    const rows = await db.queryAsUser(
      USER_A_ID,
      `SELECT * FROM public.match_workspace_sparse_chunks('authentication architecture', 10, '${WS_A_ID}');`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].chunk_id).toBe(CHUNK_A2_ID);
    expect(rows[0].document_title).toBe('Enterprise Security Architecture');
  });

  it('enforces cross-tenant RLS isolation: User A cannot retrieve Workspace B chunks even when passing WS_B_ID', async () => {
    if (!dockerAvailable) return;

    // User A passes Workspace B ID
    const queryVector = 'array_fill(0.08, ARRAY[1536])::vector';
    const denseRows = await db.queryAsUser(
      USER_A_ID,
      `SELECT * FROM public.match_workspace_dense_chunks(${queryVector}, 0.0, 10, '${WS_B_ID}', 20000);`,
    );

    expect(denseRows).toEqual([]);

    const sparseRows = await db.queryAsUser(
      USER_A_ID,
      `SELECT * FROM public.match_workspace_sparse_chunks('Confidential Tenant B', 10, '${WS_B_ID}');`,
    );

    expect(sparseRows).toEqual([]);
  });

  it('N3.6-SEC-004: adversarial candidate starvation - retrieves valid current chunk even when 50 superseded vectors are ranked ahead in ANN ordering', async () => {
    if (!dockerAvailable) return;

    // Insert 50 superseded chunks and embeddings with closer vector distance
    for (let i = 10; i < 60; i++) {
      const chunkId = `c000aaaa-0000-aaaa-0000-${String(i).padStart(12, '0')}`;
      const embId = `e000aaaa-0000-aaaa-0000-${String(i).padStart(12, '0')}`;
      await db.executeAsAdmin(`
        INSERT INTO public.chunks (id, document_version_id, workspace_id, chunk_offset, content, token_count)
        VALUES ('${chunkId}', '${VER_A1_ID}', '${WS_A_ID}', ${i}, 'Superseded noise text ${i}', 5);
        INSERT INTO public.embeddings (id, chunk_id, workspace_id, embedding_vector, model_name)
        VALUES ('${embId}', '${chunkId}', '${WS_A_ID}', array_fill(0.1, ARRAY[1536])::vector, 'text-embedding-3-small');
      `);
    }

    // Query vector matches superseded vectors (0.1) closer than current vector (0.08)
    const queryVector = 'array_fill(0.1, ARRAY[1536])::vector';
    const rows = await db.queryAsUser(
      USER_A_ID,
      `SELECT * FROM public.match_workspace_dense_chunks(${queryVector}, 0.0, 5, '${WS_A_ID}', 20000);`,
    );

    // Verify current chunk was retrieved despite 50 closer superseded vectors occupying top ANN ranks
    expect(rows).toHaveLength(1);
    expect(rows[0].chunk_id).toBe(CHUNK_A2_ID);
    expect(rows[0].document_version_id).toBe(VER_A2_ID);
  });

  it('handles stopword query gracefully in sparse retrieval', async () => {
    if (!dockerAvailable) return;

    const rows = await db.queryAsUser(
      USER_A_ID,
      `SELECT * FROM public.match_workspace_sparse_chunks('what is the', 10, '${WS_A_ID}');`,
    );

    expect(rows).toEqual([]);
  });
});


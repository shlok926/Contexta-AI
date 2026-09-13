import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { PostgresTestClient } from './test-client.js';

describe('Database Integration Test: Vector & FTS Integrity', () => {
  const db = new PostgresTestClient();

  const userAId = '44444444-4444-4444-a444-444444444444';
  const userBId = '55555555-5555-4555-b555-555555555555';
  let wsAId: string;
  let wsBId: string;
  let docVerAId: string;
  let chunkAId: string;

  beforeEach(async () => {
    await db.cleanAllTables();

    const seededA = await db.seedOrgAndAdmin('Vector Org A', 'userA@example.com', userAId, 'Workspace Vector A');
    wsAId = seededA.wsId;

    const seededB = await db.seedOrgAndAdmin('Vector Org B', 'userB@example.com', userBId, 'Workspace Vector B');
    wsBId = seededB.wsId;

    // Seed document, document_version, and chunk in Workspace A
    const docRes = await db.queryAsAdmin(`
      INSERT INTO public.documents (workspace_id, uploaded_by, title, source_type, s3_object_key)
      VALUES ('${wsAId}', '${userAId}', 'Vector Paper', 'pdf', 's3://bucket/paper.pdf')
      RETURNING id;
    `);
    const docId = docRes[0].id;

    const verRes = await db.queryAsAdmin(`
      INSERT INTO public.document_versions (document_id, workspace_id, version_number, status, is_current)
      VALUES ('${docId}', '${wsAId}', 1, 'ready', true)
      RETURNING id;
    `);
    docVerAId = verRes[0].id;

    const chkRes = await db.queryAsAdmin(`
      INSERT INTO public.chunks (document_version_id, workspace_id, chunk_offset, content, token_count)
      VALUES ('${docVerAId}', '${wsAId}', 0, 'Retrieval augmented generation with dense vector embeddings and sparse lexical search.', 12)
      RETURNING id;
    `);
    chunkAId = chkRes[0].id;
  });

  afterAll(async () => {
    await db.cleanAllTables();
  });

  it('verifies generated tsvector on chunks is populated and searchable via GIN index', async () => {
    const searchRes = await db.queryAsAdmin(`
      SELECT id, content FROM public.chunks
      WHERE tsv_content @@ to_tsquery('english', 'retrieval & augmented');
    `);
    expect(searchRes.length).toBe(1);
    expect(searchRes[0].id).toBe(chunkAId);

    // Negative FTS search
    const noMatch = await db.queryAsAdmin(`
      SELECT id FROM public.chunks
      WHERE tsv_content @@ to_tsquery('english', 'astronomy & astrophysics');
    `);
    expect(noMatch.length).toBe(0);
  });

  it('rejects chunk workspace_id mismatch with document_version (Trigger 1)', async () => {
    // Attempt to insert chunk with wsBId while document_version belongs to wsAId
    const res = await db.rawQuery(`
      INSERT INTO public.chunks (document_version_id, workspace_id, chunk_offset, content, token_count)
      VALUES ('${docVerAId}', '${wsBId}', 1, 'Mismatched workspace chunk', 5);
    `);
    expect(res.exitCode).not.toBe(0);
    expect(res.error).toMatch(/Tenancy integrity violation: chunk workspace_id does not match document_version workspace/);
  });

  it('rejects embedding workspace_id mismatch with chunk (Trigger 2)', async () => {
    // Attempt to insert embedding with wsBId while chunk belongs to wsAId
    const zeroVector = `[${Array(1536).fill(0.1).join(',')}]`;
    const res = await db.rawQuery(`
      INSERT INTO public.embeddings (chunk_id, workspace_id, embedding_vector)
      VALUES ('${chunkAId}', '${wsBId}', '${zeroVector}');
    `);
    expect(res.exitCode).not.toBe(0);
    expect(res.error).toMatch(/Tenancy integrity violation: embedding workspace_id does not match chunk workspace/);
  });

  it('rejects modification of workspace_id on persisted chunks (Trigger 3)', async () => {
    const res = await db.rawQuery(`
      UPDATE public.chunks SET workspace_id = '${wsBId}' WHERE id = '${chunkAId}';
    `);
    expect(res.exitCode).not.toBe(0);
    expect(res.error).toMatch(/(Security violation: workspace_id is strictly immutable once persisted|Tenancy integrity violation: chunk workspace_id does not match document_version workspace)/);
  });

  it('executes HNSW cosine vector search and strictly enforces RLS tenant boundaries', async () => {
    const vectorData = Array(1536).fill(0.05);
    vectorData[0] = 0.9;
    const vectorStr = `[${vectorData.join(',')}]`;

    // Insert valid embedding in Workspace A
    await db.executeAsAdmin(`
      INSERT INTO public.embeddings (chunk_id, workspace_id, embedding_vector)
      VALUES ('${chunkAId}', '${wsAId}', '${vectorStr}');
    `);

    // User A querying embeddings: returns 1 row
    const userAEmbeddings = await db.queryAsUser(userAId, `
      SELECT id, workspace_id FROM public.embeddings;
    `);
    expect(userAEmbeddings.length).toBe(1);
    expect(userAEmbeddings[0].workspace_id).toBe(wsAId);

    // User B querying embeddings: returns 0 rows (RLS boundary)
    const userBEmbeddings = await db.queryAsUser(userBId, `
      SELECT id, workspace_id FROM public.embeddings;
    `);
    expect(userBEmbeddings.length).toBe(0);

    // HNSW cosine nearest neighbor search query executes successfully
    const knnResult = await db.queryAsAdmin(`
      SELECT id, 1 - (embedding_vector <=> '${vectorStr}') as similarity
      FROM public.embeddings
      ORDER BY embedding_vector <=> '${vectorStr}'
      LIMIT 1;
    `);
    expect(knnResult.length).toBe(1);
    expect(knnResult[0].similarity).toBeGreaterThan(0.99);
  });
});

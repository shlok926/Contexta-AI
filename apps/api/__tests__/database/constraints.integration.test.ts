import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { PostgresTestClient } from './test-client.js';

describe('Database Integration Test: Schema Constraints & Cascades', () => {
  const db = new PostgresTestClient();

  const userId = '66666666-6666-4666-a666-666666666666';
  let orgId: string;
  let wsId: string;

  beforeEach(async () => {
    await db.cleanAllTables();

    const seeded = await db.seedOrgAndAdmin('Constraints Org', 'constraints@example.com', userId, 'Constraints Workspace');
    orgId = seeded.orgId;
    wsId = seeded.wsId;
  });

  afterAll(async () => {
    await db.cleanAllTables();
  });

  it('rejects invalid role in workspace_members via CHECK constraint', async () => {
    const res = await db.rawQuery(`
      INSERT INTO public.workspace_members (workspace_id, user_id, role)
      VALUES ('${wsId}', '${userId}', 'super_admin');
    `);
    expect(res.exitCode).not.toBe(0);
    expect(res.error).toMatch(/violates check constraint/);
  });

  it('accepts only the 4 canonical roles in workspace_members', async () => {
    const roles = ['viewer', 'contributor', 'workspace_admin', 'org_admin'];
    for (let i = 0; i < roles.length; i++) {
      const uId = `77777777-7777-4777-a777-77777777770${i}`;
      await db.seedAuthUser(uId, `roles_test_user_${i}@example.com`);
      await db.executeAsAdmin(`
        INSERT INTO public.users (id, organization_id, email)
        VALUES ('${uId}', '${orgId}', 'roles_test_user_${i}@example.com');
      `);

      const res = await db.rawQuery(`
        INSERT INTO public.workspace_members (workspace_id, user_id, role)
        VALUES ('${wsId}', '${uId}', '${roles[i]}');
      `);
      expect(res.exitCode).toBe(0);
    }
  });

  it('rejects invalid verification_status in citations via CHECK constraint', async () => {
    const tRes = await db.queryAsAdmin(`
      INSERT INTO public.threads (workspace_id, created_by, title)
      VALUES ('${wsId}', '${userId}', 'Run Thread') RETURNING id;
    `);
    const threadId = tRes[0].id;

    const mRes = await db.queryAsAdmin(`
      INSERT INTO public.messages (thread_id, workspace_id, role, content)
      VALUES ('${threadId}', '${wsId}', 'user', 'Run Query') RETURNING id;
    `);
    const msgId = mRes[0].id;

    const runRes = await db.queryAsAdmin(`
      INSERT INTO public.agent_runs (workspace_id, thread_id, initiating_message_id, user_id, correlation_id, query, status)
      VALUES ('${wsId}', '${threadId}', '${msgId}', '${userId}', 'corr-123', 'query', 'running')
      RETURNING id;
    `);
    const runId = runRes[0].id;

    const res = await db.rawQuery(`
      INSERT INTO public.citations (
        agent_run_id, workspace_id, claim_text, verification_status, stage1_passed
      ) VALUES (
        '${runId}', '${wsId}', 'Arbitrary claim', 'PARTIALLY_SUPPORTED', true
      );
    `);
    expect(res.exitCode).not.toBe(0);
    expect(res.error).toMatch(/violates check constraint/);
  });

  it('verifies cascading delete across document -> document_versions -> chunks -> embeddings', async () => {
    const zeroVector = `[${Array(1536).fill(0.0).join(',')}]`;
    const docRes = await db.queryAsAdmin(`
      INSERT INTO public.documents (workspace_id, uploaded_by, title, source_type, s3_object_key)
      VALUES ('${wsId}', '${userId}', 'Cascade Doc', 'pdf', 's3://bucket/cascade.pdf') RETURNING id;
    `);
    const docId = docRes[0].id;

    const verRes = await db.queryAsAdmin(`
      INSERT INTO public.document_versions (document_id, workspace_id, version_number, status, is_current)
      VALUES ('${docId}', '${wsId}', 1, 'ready', true) RETURNING id;
    `);
    const verId = verRes[0].id;

    const chkRes = await db.queryAsAdmin(`
      INSERT INTO public.chunks (document_version_id, workspace_id, chunk_offset, content, token_count)
      VALUES ('${verId}', '${wsId}', 0, 'Cascade content test', 4) RETURNING id;
    `);
    const chkId = chkRes[0].id;

    const embRes = await db.queryAsAdmin(`
      INSERT INTO public.embeddings (chunk_id, workspace_id, embedding_vector)
      VALUES ('${chkId}', '${wsId}', '${zeroVector}') RETURNING id;
    `);
    const embId = embRes[0].id;

    // Delete Document
    await db.executeAsAdmin(`DELETE FROM public.documents WHERE id = '${docId}';`);

    // Verify all child entities are removed
    const verCount = await db.queryAsAdmin(`SELECT count(*)::int as cnt FROM public.document_versions WHERE id = '${verId}';`);
    const chkCount = await db.queryAsAdmin(`SELECT count(*)::int as cnt FROM public.chunks WHERE id = '${chkId}';`);
    const embCount = await db.queryAsAdmin(`SELECT count(*)::int as cnt FROM public.embeddings WHERE id = '${embId}';`);

    expect(verCount[0].cnt).toBe(0);
    expect(chkCount[0].cnt).toBe(0);
    expect(embCount[0].cnt).toBe(0);
  });

  it('restricts organization deletion if users exist (ON DELETE RESTRICT)', async () => {
    const res = await db.rawQuery(`DELETE FROM public.organizations WHERE id = '${orgId}';`);
    expect(res.exitCode).not.toBe(0);
    expect(res.error).toMatch(/violates foreign key constraint/);
  });
});

import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { PostgresTestClient } from './test-client.js';

describe('Database Integration Test: RLS Tenancy Isolation', () => {
  const db = new PostgresTestClient();

  const userAId = '11111111-1111-4111-a111-111111111111';
  const userBId = '22222222-2222-4222-b222-222222222222';
  let orgAId: string;
  let wsAId: string;
  let orgBId: string;
  let wsBId: string;

  beforeEach(async () => {
    await db.cleanAllTables();

    // Provision Tenant A
    const resA = await db.seedOrgAndAdmin('Tenant Alpha', 'admin.a@example.com', userAId, 'Workspace Alpha');
    orgAId = resA.orgId;
    wsAId = resA.wsId;

    // Provision Tenant B
    const resB = await db.seedOrgAndAdmin('Tenant Beta', 'admin.b@example.com', userBId, 'Workspace Beta');
    orgBId = resB.orgId;
    wsBId = resB.wsId;

    // Seed threads and messages in both workspaces
    await db.executeAsAdmin(`
      INSERT INTO public.threads (id, workspace_id, created_by, title)
      VALUES 
        ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '${wsAId}', '${userAId}', 'Thread Alpha'),
        ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '${wsBId}', '${userBId}', 'Thread Beta');

      INSERT INTO public.messages (id, thread_id, workspace_id, user_id, role, content)
      VALUES
        ('1111aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '${wsAId}', '${userAId}', 'user', 'Hello from Alpha'),
        ('2222bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '${wsBId}', '${userBId}', 'user', 'Hello from Beta');

      INSERT INTO public.documents (id, workspace_id, uploaded_by, title, source_type, s3_object_key)
      VALUES
        ('d000aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '${wsAId}', '${userAId}', 'Doc Alpha', 'pdf', 's3://bucket/alpha.pdf'),
        ('d000bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '${wsBId}', '${userBId}', 'Doc Beta', 'pdf', 's3://bucket/beta.pdf');
    `);
  });

  afterAll(async () => {
    await db.cleanAllTables();
  });

  it('verifies User A can only SELECT entities in Workspace A, with zero rows from Workspace B', async () => {
    const threads = await db.queryAsUser(userAId, `SELECT id, title, workspace_id FROM public.threads`);
    expect(threads.length).toBe(1);
    expect(threads[0].id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(threads[0].workspace_id).toBe(wsAId);

    const messages = await db.queryAsUser(userAId, `SELECT id, content, workspace_id FROM public.messages`);
    expect(messages.length).toBe(1);
    expect(messages[0].id).toBe('1111aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(messages[0].workspace_id).toBe(wsAId);

    const documents = await db.queryAsUser(userAId, `SELECT id, title, workspace_id FROM public.documents`);
    expect(documents.length).toBe(1);
    expect(documents[0].id).toBe('d000aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(documents[0].workspace_id).toBe(wsAId);
  });

  it('verifies User B can only SELECT entities in Workspace B, with zero rows from Workspace A', async () => {
    const threads = await db.queryAsUser(userBId, `SELECT id, title, workspace_id FROM public.threads`);
    expect(threads.length).toBe(1);
    expect(threads[0].id).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    expect(threads[0].workspace_id).toBe(wsBId);

    const messages = await db.queryAsUser(userBId, `SELECT id, content, workspace_id FROM public.messages`);
    expect(messages.length).toBe(1);
    expect(messages[0].id).toBe('2222bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    expect(messages[0].workspace_id).toBe(wsBId);
  });

  it('rejects User A attempting to INSERT a thread into Workspace B (RLS violation)', async () => {
    const res = await db.executeAsUser(userAId, `
      INSERT INTO public.threads (workspace_id, created_by, title)
      VALUES ('${wsBId}', '${userAId}', 'Adversarial Thread in Beta');
    `);
    expect(res.exitCode).not.toBe(0);
    expect(res.error).toMatch(/new row violates row-level security policy/);
  });

  it('prevents User A from UPDATE of Workspace B thread (0 rows updated)', async () => {
    await db.executeAsUser(userAId, `
      UPDATE public.threads SET title = 'Hacked by Alpha' WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    `);

    // Verify Title in Beta remains untouched
    const adminCheck = await db.queryAsAdmin(`
      SELECT title FROM public.threads WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    `);
    expect(adminCheck[0].title).toBe('Thread Beta');
  });

  it('prevents User A from DELETE of Workspace B thread (0 rows deleted)', async () => {
    await db.executeAsUser(userAId, `
      DELETE FROM public.threads WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    `);

    const adminCheck = await db.queryAsAdmin(`
      SELECT count(*)::int as cnt FROM public.threads WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    `);
    expect(adminCheck[0].cnt).toBe(1);
  });

  it('verifies workspace_members query executes without recursion (SQLSTATE 42P17) and isolates records', async () => {
    const members = await db.queryAsUser(userAId, `
      SELECT workspace_id, user_id, role FROM public.workspace_members;
    `);
    expect(members.length).toBe(1);
    expect(members[0].workspace_id).toBe(wsAId);
    expect(members[0].user_id).toBe(userAId);
  });
});

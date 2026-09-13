import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { PostgresTestClient } from './test-client.js';

describe('Database Integration Test: Document Versioning & Lifecycle', () => {
  const db = new PostgresTestClient();

  const userId = '33333333-3333-4333-a333-333333333333';
  let wsId: string;
  let docId: string;

  beforeEach(async () => {
    await db.cleanAllTables();

    const seeded = await db.seedOrgAndAdmin('Doc Org', 'docadmin@example.com', userId, 'Doc Workspace');
    wsId = seeded.wsId;

    // Create Document container
    const docRes = await db.queryAsAdmin(`
      INSERT INTO public.documents (workspace_id, uploaded_by, title, source_type, s3_object_key)
      VALUES ('${wsId}', '${userId}', 'Architecture Spec', 'pdf', 's3://bucket/spec.pdf')
      RETURNING id;
    `);
    docId = docRes[0].id;
  });

  afterAll(async () => {
    await db.cleanAllTables();
  });

  it('verifies initial version processing allows zero current versions', async () => {
    await db.executeAsAdmin(`
      INSERT INTO public.document_versions (document_id, workspace_id, version_number, status, is_current)
      VALUES ('${docId}', '${wsId}', 1, 'pending', false);
    `);

    const versions = await db.queryAsAdmin(`
      SELECT version_number, status, is_current FROM public.document_versions WHERE document_id = '${docId}';
    `);
    expect(versions.length).toBe(1);
    expect(versions[0].is_current).toBe(false);
    expect(versions[0].status).toBe('pending');
  });

  it('verifies successful activation transitions version 1 to ready and current', async () => {
    await db.executeAsAdmin(`
      INSERT INTO public.document_versions (document_id, workspace_id, version_number, status, is_current)
      VALUES ('${docId}', '${wsId}', 1, 'ready', true);
    `);

    const currentVersions = await db.queryAsAdmin(`
      SELECT version_number, status FROM public.document_versions 
      WHERE document_id = '${docId}' AND is_current = true;
    `);
    expect(currentVersions.length).toBe(1);
    expect(currentVersions[0].version_number).toBe(1);
    expect(currentVersions[0].status).toBe('ready');
  });

  it('ensures v2 processing does not disturb v1 active/ready status', async () => {
    // Version 1 is ready and active
    await db.executeAsAdmin(`
      INSERT INTO public.document_versions (document_id, workspace_id, version_number, status, is_current)
      VALUES ('${docId}', '${wsId}', 1, 'ready', true);
    `);

    // Ingesting Version 2
    await db.executeAsAdmin(`
      INSERT INTO public.document_versions (document_id, workspace_id, version_number, status, is_current)
      VALUES ('${docId}', '${wsId}', 2, 'processing', false);
    `);

    // Only v1 is active and current
    const active = await db.queryAsAdmin(`
      SELECT version_number FROM public.document_versions 
      WHERE document_id = '${docId}' AND status = 'ready' AND is_current = true;
    `);
    expect(active.length).toBe(1);
    expect(active[0].version_number).toBe(1);
  });

  it('ensures failed v2 preserves v1 active/ready status', async () => {
    await db.executeAsAdmin(`
      INSERT INTO public.document_versions (document_id, workspace_id, version_number, status, is_current)
      VALUES ('${docId}', '${wsId}', 1, 'ready', true);

      INSERT INTO public.document_versions (document_id, workspace_id, version_number, status, is_current)
      VALUES ('${docId}', '${wsId}', 2, 'failed', false);
    `);

    const active = await db.queryAsAdmin(`
      SELECT version_number FROM public.document_versions 
      WHERE document_id = '${docId}' AND status = 'ready' AND is_current = true;
    `);
    expect(active.length).toBe(1);
    expect(active[0].version_number).toBe(1);
  });

  it('rejects concurrent is_current=true on two versions via partial unique index', async () => {
    await db.executeAsAdmin(`
      INSERT INTO public.document_versions (document_id, workspace_id, version_number, status, is_current)
      VALUES ('${docId}', '${wsId}', 1, 'ready', true);
    `);

    // Attempt to insert v2 also with is_current = true
    const res = await db.rawQuery(`
      INSERT INTO public.document_versions (document_id, workspace_id, version_number, status, is_current)
      VALUES ('${docId}', '${wsId}', 2, 'ready', true);
    `);

    expect(res.exitCode).not.toBe(0);
    expect(res.error).toMatch(/duplicate key value violates unique constraint "uq_document_versions_current"/);
  });

  it('enforces version number uniqueness per document', async () => {
    await db.executeAsAdmin(`
      INSERT INTO public.document_versions (document_id, workspace_id, version_number, status, is_current)
      VALUES ('${docId}', '${wsId}', 1, 'ready', true);
    `);

    const res = await db.rawQuery(`
      INSERT INTO public.document_versions (document_id, workspace_id, version_number, status, is_current)
      VALUES ('${docId}', '${wsId}', 1, 'processing', false);
    `);

    expect(res.exitCode).not.toBe(0);
    expect(res.error).toMatch(/duplicate key value violates unique constraint "uq_document_versions_doc_ver"/);
  });
});

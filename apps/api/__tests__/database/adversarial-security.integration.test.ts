import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { PostgresTestClient } from './test-client.js';

describe('Database Integration Test: Adversarial Security & RBAC Boundary', () => {
  const db = new PostgresTestClient();

  const orgAdminAId = 'aaaaaaaa-aaaa-4000-8000-aaaaaaaaaaaa';
  const viewerAId   = '11111111-1111-4000-8000-111111111111';
  const contribAId  = 'cccccccc-cccc-4000-8000-cccccccccccc';
  const wsAdminAId  = '22222222-2222-4000-8000-222222222222';
  const orgAdminBId = 'bbbbbbbb-bbbb-4000-8000-bbbbbbbbbbbb';

  let orgAId: string;
  let wsAId: string;
  let orgBId: string;
  let wsBId: string;

  beforeEach(async () => {
    await db.cleanAllTables();

    // Canonical Enterprise Bootstrap: Root Provisioning establishes Org A, Root Workspace, Org Admin
    const resA = await db.seedOrgAndAdmin('Enterprise Alpha', 'admin@alpha.com', orgAdminAId, 'Alpha Root Workspace');
    orgAId = resA.orgId;
    wsAId = resA.wsId;

    // Bootstrap Org B
    const resB = await db.seedOrgAndAdmin('Enterprise Beta', 'admin@beta.com', orgAdminBId, 'Beta Root Workspace');
    orgBId = resB.orgId;
    wsBId = resB.wsId;

    // Seed users in Org A with different roles in Workspace A
    await db.seedAuthUser(viewerAId, 'viewer@alpha.com');
    await db.seedAuthUser(contribAId, 'contrib@alpha.com');
    await db.seedAuthUser(wsAdminAId, 'wsadmin@alpha.com');

    await db.executeAsAdmin(`
      INSERT INTO public.users (id, organization_id, email, full_name) VALUES
        ('${viewerAId}', '${orgAId}', 'viewer@alpha.com', 'Viewer User'),
        ('${contribAId}', '${orgAId}', 'contrib@alpha.com', 'Contributor User'),
        ('${wsAdminAId}', '${orgAId}', 'wsadmin@alpha.com', 'Workspace Admin User');

      INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
        ('${wsAId}', '${viewerAId}', 'viewer'),
        ('${wsAId}', '${contribAId}', 'contributor'),
        ('${wsAId}', '${wsAdminAId}', 'workspace_admin');
    `);
  });

  afterAll(async () => {
    await db.cleanAllTables();
  });

  it('rejects workspace creation by viewer role', async () => {
    const res = await db.executeAsUser(viewerAId, `
      INSERT INTO public.workspaces (organization_id, name)
      VALUES ('${orgAId}', 'Viewer Unauthorized Workspace');
    `);
    expect(res.exitCode).not.toBe(0);
    expect(res.error).toMatch(/new row violates row-level security policy/);
  });

  it('rejects workspace creation by contributor role', async () => {
    const res = await db.executeAsUser(contribAId, `
      INSERT INTO public.workspaces (organization_id, name)
      VALUES ('${orgAId}', 'Contributor Unauthorized Workspace');
    `);
    expect(res.exitCode).not.toBe(0);
    expect(res.error).toMatch(/new row violates row-level security policy/);
  });

  it('rejects workspace creation by workspace_admin lacking org_admin role', async () => {
    const res = await db.executeAsUser(wsAdminAId, `
      INSERT INTO public.workspaces (organization_id, name)
      VALUES ('${orgAId}', 'WS Admin Unauthorized Workspace');
    `);
    expect(res.exitCode).not.toBe(0);
    expect(res.error).toMatch(/new row violates row-level security policy/);
  });

  it('allows workspace creation by authenticated org_admin within their organization', async () => {
    const res = await db.executeAsUser(orgAdminAId, `
      INSERT INTO public.workspaces (organization_id, name)
      VALUES ('${orgAId}', 'Alpha Engineering Workspace');
    `);
    expect(res.exitCode).toBe(0);

    const workspaces = await db.queryAsAdmin(`
      SELECT name FROM public.workspaces WHERE organization_id = '${orgAId}' AND name = 'Alpha Engineering Workspace';
    `);
    expect(workspaces.length).toBe(1);
    expect(workspaces[0].name).toBe('Alpha Engineering Workspace');
  });

  it('prevents org_admin of Org B from creating workspace in Org A (Cross-Org Creation Attack)', async () => {
    const res = await db.executeAsUser(orgAdminBId, `
      INSERT INTO public.workspaces (organization_id, name)
      VALUES ('${orgAId}', 'Beta Hostile Workspace in Alpha');
    `);
    expect(res.exitCode).not.toBe(0);
    expect(res.error).toMatch(/new row violates row-level security policy/);
  });

  it('revokes execution on SECURITY DEFINER helpers from anon/PUBLIC roles', async () => {
    // Attempt to invoke helper as anon role
    const res = await db.rawQuery(`
      SET ROLE anon;
      SELECT public.get_authenticated_user_workspace_ids();
    `);
    expect(res.exitCode).not.toBe(0);
    expect(res.error).toMatch(/permission denied for function get_authenticated_user_workspace_ids/);
  });

  it('guarantees zero-argument helper derives identity from session auth.uid() without argument injection', async () => {
    const resViewer = await db.queryAsUser(viewerAId, `
      SELECT * FROM public.get_authenticated_user_workspace_ids();
    `);
    expect(resViewer.length).toBe(1);
    expect(resViewer[0].get_authenticated_user_workspace_ids).toBe(wsAId);

    const resOrgB = await db.queryAsUser(orgAdminBId, `
      SELECT * FROM public.get_authenticated_user_workspace_ids();
    `);
    expect(resOrgB.length).toBe(1);
    expect(resOrgB[0].get_authenticated_user_workspace_ids).toBe(wsBId);
  });

  it('enforces strict audit logs isolation: NULL workspace_id logs are invisible across organizations', async () => {
    // Insert audit log in Org A with workspace_id IS NULL (e.g. Org-level policy change)
    // and an audit log in Org B with workspace_id IS NULL
    await db.executeAsAdmin(`
      INSERT INTO public.audit_logs (workspace_id, actor_user_id, action_type, metadata)
      VALUES 
        (NULL, '${orgAdminAId}', 'ORG_SETTINGS_UPDATE', '{"param": "security_level"}'::jsonb),
        (NULL, '${orgAdminBId}', 'ORG_SETTINGS_UPDATE', '{"param": "retention_period"}'::jsonb);
    `);

    // Org Admin A queries audit logs: should see only Org A's NULL log, NEVER Org B's
    const logsA = await db.queryAsUser(orgAdminAId, `
      SELECT actor_user_id, action_type FROM public.audit_logs WHERE workspace_id IS NULL;
    `);
    expect(logsA.length).toBe(1);
    expect(logsA[0].actor_user_id).toBe(orgAdminAId);

    // Org Admin B queries audit logs: should see only Org B's NULL log
    const logsB = await db.queryAsUser(orgAdminBId, `
      SELECT actor_user_id, action_type FROM public.audit_logs WHERE workspace_id IS NULL;
    `);
    expect(logsB.length).toBe(1);
    expect(logsB[0].actor_user_id).toBe(orgAdminBId);

    // Viewer in Org A should see 0 NULL logs (only org_admin can view org-level logs)
    const logsViewer = await db.queryAsUser(viewerAId, `
      SELECT actor_user_id, action_type FROM public.audit_logs WHERE workspace_id IS NULL;
    `);
    expect(logsViewer.length).toBe(0);
  });
});

import { describe, it, expect, beforeEach, afterAll, beforeAll } from '@jest/globals';
import { SignJWT } from 'jose';
import { PostgresTestClient } from './test-client.js';

describe('N2.10 Live PostgreSQL / PostgREST / RLS Security Verification Matrix', () => {
  const db = new PostgresTestClient();

  const JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';
  const SUPABASE_REST_URL = 'http://127.0.0.1:54321/rest/v1';
  const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

  const userA1Id = '11111111-1111-4111-a111-111111111111'; // Org A, org_admin
  const userA2Id = '11111111-2222-4111-a222-222222222222'; // Org A, viewer on WsA1, contributor on WsA2
  const userB1Id = '22222222-1111-4222-b111-111111111111'; // Org B, org_admin
  const userFreshId = '33333333-3333-4333-c333-333333333333'; // Org C, fresh user with 0 workspaces

  let orgAId: string;
  let wsA1Id: string;
  let wsA2Id: string;

  let orgBId: string;
  let wsB1Id: string;

  let orgCId: string;

  async function generateJwt(userId: string, email: string): Promise<string> {
    return new SignJWT({
      sub: userId,
      role: 'authenticated',
      aud: 'authenticated',
      email,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(JWT_SECRET));
  }

  beforeEach(async () => {
    await db.cleanAllTables();

    // 1. Provision Organization A + User A1 (org_admin) + Ws A1
    const resA = await db.seedOrgAndAdmin('Org Alpha', 'admin.a1@alpha.com', userA1Id, 'Workspace Alpha-1');
    orgAId = resA.orgId;
    wsA1Id = resA.wsId;

    // 2. Add Ws A2 to Org A
    const wsA2Res = await db.queryAsAdmin<{ id: string }>(`
      INSERT INTO public.workspaces (organization_id, name)
      VALUES ('${orgAId}', 'Workspace Alpha-2')
      RETURNING id;
    `);
    wsA2Id = wsA2Res[0].id;

    // 3. Provision User A2 in Org A (viewer on WsA1, contributor on WsA2)
    await db.seedAuthUser(userA2Id, 'user.a2@alpha.com');
    await db.executeAsAdmin(`
      INSERT INTO public.users (id, organization_id, email, full_name)
      VALUES ('${userA2Id}', '${orgAId}', 'user.a2@alpha.com', 'User A2');

      INSERT INTO public.workspace_members (workspace_id, user_id, role)
      VALUES 
        ('${wsA1Id}', '${userA2Id}', 'viewer'),
        ('${wsA2Id}', '${userA2Id}', 'contributor');
    `);

    // 4. Provision Organization B + User B1 (org_admin) + Ws B1
    const resB = await db.seedOrgAndAdmin('Org Beta', 'admin.b1@beta.com', userB1Id, 'Workspace Beta-1');
    orgBId = resB.orgId;
    wsB1Id = resB.wsId;

    // 5. Provision Organization C + Fresh User (0 workspaces)
    await db.seedAuthUser(userFreshId, 'fresh@gamma.com');
    const orgCRes = await db.queryAsAdmin<{ id: string }>(`
      INSERT INTO public.organizations (name) VALUES ('Org Gamma') RETURNING id;
    `);
    orgCId = orgCRes[0].id;
    await db.executeAsAdmin(`
      INSERT INTO public.users (id, organization_id, email, full_name)
      VALUES ('${userFreshId}', '${orgCId}', 'fresh@gamma.com', 'Fresh User');
    `);
  });

  afterAll(async () => {
    await db.cleanAllTables();
  });

  // ===========================================================================
  // SECTION 1: LIVE RLS CATALOG VERIFICATION
  // ===========================================================================
  describe('1. Live RLS Catalog Verification', () => {
    it('verifies all 15 canonical tables have Row-Level Security enabled', async () => {
      const tables = await db.queryAsAdmin<{ tablename: string; rowsecurity: boolean }>(`
        SELECT tablename, rowsecurity 
        FROM pg_tables 
        WHERE schemaname = 'public' 
        ORDER BY tablename;
      `);

      const expected15 = [
        'agent_run_steps',
        'agent_runs',
        'audit_logs',
        'chunks',
        'citations',
        'document_versions',
        'documents',
        'embeddings',
        'memory_entries',
        'messages',
        'organizations',
        'threads',
        'users',
        'workspace_members',
        'workspaces',
      ];

      expect(tables.map((t) => t.tablename)).toEqual(expected15);
      for (const t of tables) {
        expect(t.rowsecurity).toBe(true);
      }
    });

    it('verifies that pg_policies covers all 15 tables with authenticated role policies', async () => {
      const policies = await db.queryAsAdmin<{ tablename: string; policyname: string; roles: string[] }>(`
        SELECT tablename, policyname, roles 
        FROM pg_policies 
        WHERE schemaname = 'public';
      `);

      expect(policies.length).toBeGreaterThanOrEqual(15);
      const coveredTables = new Set(policies.map((p) => p.tablename));
      expect(coveredTables.size).toBe(15);
    });
  });

  // ===========================================================================
  // SECTION 2: IDENTITY MODEL & auth.uid() EXECUTION CONTEXT
  // ===========================================================================
  describe('2. Database Identity Model & auth.uid() Resolution', () => {
    it('proves auth.uid() accurately resolves caller identity from session claims', async () => {
      const caller = await db.queryAsUser<{ uid: string }>(userA1Id, `SELECT auth.uid() as uid`);
      expect(caller[0].uid).toBe(userA1Id);
    });

    it('proves get_authenticated_user_organization_id() resolves authoritative user organization', async () => {
      const orgA = await db.queryAsUser<{ org_id: string }>(
        userA1Id,
        `SELECT public.get_authenticated_user_organization_id() as org_id`,
      );
      expect(orgA[0].org_id).toBe(orgAId);

      const orgB = await db.queryAsUser<{ org_id: string }>(
        userB1Id,
        `SELECT public.get_authenticated_user_organization_id() as org_id`,
      );
      expect(orgB[0].org_id).toBe(orgBId);
    });

    it('proves get_authenticated_user_workspace_ids() returns only memberships of caller', async () => {
      const wsA1 = await db.queryAsUser<{ ws_id: string }>(
        userA1Id,
        `SELECT public.get_authenticated_user_workspace_ids() as ws_id`,
      );
      expect(wsA1.map((w) => w.ws_id)).toEqual([wsA1Id]);

      const wsA2 = await db.queryAsUser<{ ws_id: string }>(
        userA2Id,
        `SELECT public.get_authenticated_user_workspace_ids() as ws_id ORDER BY ws_id`,
      );
      expect(wsA2.map((w) => w.ws_id).sort()).toEqual([wsA1Id, wsA2Id].sort());
    });
  });

  // ===========================================================================
  // SECTION 3: EFFECTIVE PRIVILEGES (Layer A vs Layer B)
  // ===========================================================================
  describe('3. Effective Privileges & RLS Policy Enforcement', () => {
    it('proves authenticated role has table-level SELECT privilege, but RLS restricts rows (Layer A vs Layer B)', async () => {
      const priv = await db.queryAsAdmin<{ has_priv: boolean }>(`
        SELECT has_table_privilege('authenticated', 'public.workspaces', 'SELECT') as has_priv;
      `);
      expect(priv[0].has_priv).toBe(true);

      // User B queries workspaces table: Layer A allows query execution, Layer B (RLS) returns 1 row (WsB1) and hides WsA1, WsA2
      const userBWorkspaces = await db.queryAsUser<{ id: string }>(
        userB1Id,
        `SELECT id FROM public.workspaces;`,
      );
      expect(userBWorkspaces.length).toBe(1);
      expect(userBWorkspaces[0].id).toBe(wsB1Id);
    });

    it('proves anon role lacks EXECUTE privilege on SECURITY DEFINER helper functions', async () => {
      const anonExec = await db.queryAsAdmin<{ can_exec: boolean }>(`
        SELECT has_function_privilege('anon', 'public.get_authenticated_user_workspace_ids()', 'EXECUTE') as can_exec;
      `);
      expect(anonExec[0].can_exec).toBe(false);
    });
  });

  // ===========================================================================
  // SECTION 4: WORKSPACE BOOTSTRAP RPC VERIFICATION
  // ===========================================================================
  describe('4. public.bootstrap_workspace(p_name) Live Execution', () => {
    it('Case A: First workspace bootstrap for user with zero visible workspaces', async () => {
      const res = await db.queryAsUser<{ new_ws_id: string }>(
        userFreshId,
        `SELECT public.bootstrap_workspace('Gamma Production') as new_ws_id;`,
      );

      const newWsId = res[0].new_ws_id;
      expect(newWsId).toBeDefined();

      // Verify workspace entity created under Org Gamma
      const ws = await db.queryAsAdmin<{ id: string; organization_id: string; name: string }>(`
        SELECT id, organization_id, name FROM public.workspaces WHERE id = '${newWsId}';
      `);
      expect(ws[0].organization_id).toBe(orgCId);
      expect(ws[0].name).toBe('Gamma Production');

      // Verify initial membership created as org_admin
      const mem = await db.queryAsAdmin<{ user_id: string; role: string }>(`
        SELECT user_id, role FROM public.workspace_members WHERE workspace_id = '${newWsId}';
      `);
      expect(mem[0].user_id).toBe(userFreshId);
      expect(mem[0].role).toBe('org_admin');

      // Verify audit log entry
      const audit = await db.queryAsAdmin<{ action_type: string; actor_user_id: string }>(`
        SELECT action_type, actor_user_id FROM public.audit_logs WHERE workspace_id = '${newWsId}';
      `);
      expect(audit[0].action_type).toBe('WORKSPACE_BOOTSTRAP');
      expect(audit[0].actor_user_id).toBe(userFreshId);
    });

    it('Case B: Existing org_admin creates additional workspace', async () => {
      const res = await db.queryAsUser<{ new_ws_id: string }>(
        userA1Id,
        `SELECT public.bootstrap_workspace('Alpha-3 Analytics') as new_ws_id;`,
      );

      const newWsId = res[0].new_ws_id;
      expect(newWsId).toBeDefined();

      const ws = await db.queryAsAdmin<{ organization_id: string; name: string }>(`
        SELECT organization_id, name FROM public.workspaces WHERE id = '${newWsId}';
      `);
      expect(ws[0].organization_id).toBe(orgAId);
      expect(ws[0].name).toBe('Alpha-3 Analytics');
    });

    it('Case C: Existing non-org-admin (viewer/contributor) is rejected with 42501', async () => {
      const res = await db.executeAsUser(
        userA2Id,
        `SELECT public.bootstrap_workspace('Unauthorized Workspace');`,
      );

      expect(res.exitCode).not.toBe(0);
      expect(res.error).toMatch(/FORBIDDEN: Caller must hold org_admin role/);

      // Verify zero workspaces created
      const count = await db.queryAsAdmin<{ cnt: number }>(`
        SELECT count(*)::int as cnt FROM public.workspaces WHERE name = 'Unauthorized Workspace';
      `);
      expect(count[0].cnt).toBe(0);
    });

    it('Case D: Input validation rejects empty or oversized workspace name with 22023', async () => {
      const emptyRes = await db.executeAsUser(userA1Id, `SELECT public.bootstrap_workspace('   ');`);
      expect(emptyRes.exitCode).not.toBe(0);
      expect(emptyRes.error).toMatch(/INVALID_PARAMETER: Workspace name must not be empty/);

      const longName = 'A'.repeat(256);
      const longRes = await db.executeAsUser(userA1Id, `SELECT public.bootstrap_workspace('${longName}');`);
      expect(longRes.exitCode).not.toBe(0);
      expect(longRes.error).toMatch(/INVALID_PARAMETER: Workspace name exceeds maximum length/);
    });
  });

  // ===========================================================================
  // SECTION 5: CROSS-TENANT ISOLATION MATRIX (Negative & Positive)
  // ===========================================================================
  describe('5. Cross-Tenant Isolation Matrix', () => {
    it('verifies Cross-Tenant READ: User A cannot read Workspaces, Members, Threads, or Documents from Org B', async () => {
      // 1. Workspaces
      const wsA = await db.queryAsUser<{ id: string }>(userA1Id, `SELECT id FROM public.workspaces WHERE id = '${wsB1Id}'`);
      expect(wsA.length).toBe(0);

      // 2. Workspace Members
      const memA = await db.queryAsUser<{ id: string }>(userA1Id, `SELECT id FROM public.workspace_members WHERE workspace_id = '${wsB1Id}'`);
      expect(memA.length).toBe(0);

      // 3. Threads
      await db.executeAsAdmin(`
        INSERT INTO public.threads (id, workspace_id, created_by, title)
        VALUES ('bbbbbbbb-1111-4111-b111-111111111111', '${wsB1Id}', '${userB1Id}', 'Beta Secret Thread');
      `);
      const threadsA = await db.queryAsUser<{ id: string }>(userA1Id, `SELECT id FROM public.threads WHERE workspace_id = '${wsB1Id}'`);
      expect(threadsA.length).toBe(0);

      // 4. Documents
      await db.executeAsAdmin(`
        INSERT INTO public.documents (id, workspace_id, uploaded_by, title, source_type, s3_object_key)
        VALUES ('bbbbbbbb-2222-4111-b222-222222222222', '${wsB1Id}', '${userB1Id}', 'Beta Secret Doc', 'pdf', 's3://beta/secret.pdf');
      `);
      const docsA = await db.queryAsUser<{ id: string }>(userA1Id, `SELECT id FROM public.documents WHERE workspace_id = '${wsB1Id}'`);
      expect(docsA.length).toBe(0);
    });

    it('verifies Cross-Tenant INSERT: User A cannot insert records into Workspace B', async () => {
      const res = await db.executeAsUser(userA1Id, `
        INSERT INTO public.threads (workspace_id, created_by, title)
        VALUES ('${wsB1Id}', '${userA1Id}', 'Attacker Thread in Beta');
      `);
      expect(res.exitCode).not.toBe(0);
      expect(res.error).toMatch(/violates row-level security policy/);
    });

    it('verifies Cross-Tenant UPDATE: User A cannot update records in Workspace B (0 rows affected)', async () => {
      await db.executeAsAdmin(`
        INSERT INTO public.threads (id, workspace_id, created_by, title)
        VALUES ('bbbbbbbb-3333-4111-b333-333333333333', '${wsB1Id}', '${userB1Id}', 'Original Beta Title');
      `);

      await db.executeAsUser(userA1Id, `
        UPDATE public.threads SET title = 'Hacked by Alpha' WHERE id = 'bbbbbbbb-3333-4111-b333-333333333333';
      `);

      const adminCheck = await db.queryAsAdmin<{ title: string }>(`
        SELECT title FROM public.threads WHERE id = 'bbbbbbbb-3333-4111-b333-333333333333';
      `);
      expect(adminCheck[0].title).toBe('Original Beta Title');
    });

    it('verifies Cross-Tenant DELETE: User A cannot delete records in Workspace B (0 rows affected)', async () => {
      await db.executeAsAdmin(`
        INSERT INTO public.threads (id, workspace_id, created_by, title)
        VALUES ('bbbbbbbb-4444-4111-b444-444444444444', '${wsB1Id}', '${userB1Id}', 'Beta Thread To Preserve');
      `);

      await db.executeAsUser(userA1Id, `
        DELETE FROM public.threads WHERE id = 'bbbbbbbb-4444-4111-b444-444444444444';
      `);

      const count = await db.queryAsAdmin<{ cnt: number }>(`
        SELECT count(*)::int as cnt FROM public.threads WHERE id = 'bbbbbbbb-4444-4111-b444-444444444444';
      `);
      expect(count[0].cnt).toBe(1);
    });
  });

  // ===========================================================================
  // SECTION 6: VECTOR & CHUNK TENANCY (ADR-0002)
  // ===========================================================================
  describe('6. Vector & Chunk Tenancy Boundaries', () => {
    it('verifies triggers enforce workspace lineage between document, version, chunk, and embedding', async () => {
      // 1. Create document & version in WsA1
      const docId = 'aaaaaaaa-1111-4111-a111-111111111111';
      const verId = 'aaaaaaaa-2222-4111-a222-222222222222';
      await db.executeAsAdmin(`
        INSERT INTO public.documents (id, workspace_id, uploaded_by, title, source_type, s3_object_key)
        VALUES ('${docId}', '${wsA1Id}', '${userA1Id}', 'Alpha Spec', 'pdf', 's3://alpha/spec.pdf');

        INSERT INTO public.document_versions (id, document_id, workspace_id, version_number, status, is_current)
        VALUES ('${verId}', '${docId}', '${wsA1Id}', 1, 'ready', true);
      `);

      // 2. Attempt to insert chunk with WsB1 workspace_id (mismatch -> Trigger 1 rejects)
      const chunkFail = await db.rawQuery(`
        INSERT INTO public.chunks (document_version_id, workspace_id, chunk_offset, content, token_count)
        VALUES ('${verId}', '${wsB1Id}', 0, 'Cross tenant chunk', 10);
      `);
      expect(chunkFail.exitCode).not.toBe(0);
      expect(chunkFail.error).toMatch(/Tenancy integrity violation: chunk workspace_id/);

      // 3. Insert valid chunk in WsA1
      const chunkId = 'aaaaaaaa-3333-4111-a333-333333333333';
      await db.executeAsAdmin(`
        INSERT INTO public.chunks (id, document_version_id, workspace_id, chunk_offset, content, token_count)
        VALUES ('${chunkId}', '${verId}', '${wsA1Id}', 0, 'Alpha valid chunk content', 10);
      `);

      // 4. Attempt to insert embedding with WsB1 workspace_id (mismatch -> Trigger 2 rejects)
      const zeroVector = `[${Array(1536).fill(0.01).join(',')}]`;
      const embFail = await db.rawQuery(`
        INSERT INTO public.embeddings (chunk_id, workspace_id, embedding_vector)
        VALUES ('${chunkId}', '${wsB1Id}', '${zeroVector}'::vector);
      `);
      expect(embFail.exitCode).not.toBe(0);
      expect(embFail.error).toMatch(/Tenancy integrity violation: embedding workspace_id/);

      // 5. Attempt to update chunk workspace_id (Triggers reject tenancy drift/immutability violation)
      const updateWsFail = await db.rawQuery(`
        UPDATE public.chunks SET workspace_id = '${wsB1Id}' WHERE id = '${chunkId}';
      `);
      expect(updateWsFail.exitCode).not.toBe(0);
      expect(updateWsFail.error).toMatch(/Tenancy integrity violation|workspace_id is strictly immutable/);
    });
  });

  // ===========================================================================
  // SECTION 7: MEMORY TENANCY & VISIBILITY
  // ===========================================================================
  describe('7. Memory Tenancy & Visibility Rules', () => {
    it('verifies user_private memory is visible ONLY to author and hidden from co-members and cross-tenant users', async () => {
      const privMemId = 'aaaaaaaa-5555-4111-a555-555555555555';
      await db.executeAsAdmin(`
        INSERT INTO public.memory_entries (id, workspace_id, user_id, visibility, memory_type, content, reason)
        VALUES ('${privMemId}', '${wsA1Id}', '${userA1Id}', 'user_private', 'user_preference', 'Prefers Python', 'Explicit');
      `);

      // Author A1 sees private memory
      const resA1 = await db.queryAsUser(userA1Id, `SELECT id FROM public.memory_entries WHERE id = '${privMemId}'`);
      expect(resA1.length).toBe(1);

      // Co-member A2 in WsA1 CANNOT see private memory
      const resA2 = await db.queryAsUser(userA2Id, `SELECT id FROM public.memory_entries WHERE id = '${privMemId}'`);
      expect(resA2.length).toBe(0);

      // Cross-tenant user B1 CANNOT see private memory
      const resB1 = await db.queryAsUser(userB1Id, `SELECT id FROM public.memory_entries WHERE id = '${privMemId}'`);
      expect(resB1.length).toBe(0);
    });

    it('verifies workspace_shared memory is visible to workspace co-members but invisible cross-tenant', async () => {
      const sharedMemId = 'aaaaaaaa-6666-4111-a666-666666666666';
      await db.executeAsAdmin(`
        INSERT INTO public.memory_entries (id, workspace_id, user_id, visibility, memory_type, content, reason)
        VALUES ('${sharedMemId}', '${wsA1Id}', '${userA1Id}', 'workspace_shared', 'project_context', 'Project Apollo', 'Context');
      `);

      // Author A1 sees shared memory
      const resA1 = await db.queryAsUser(userA1Id, `SELECT id FROM public.memory_entries WHERE id = '${sharedMemId}'`);
      expect(resA1.length).toBe(1);

      // Co-member A2 sees shared memory
      const resA2 = await db.queryAsUser(userA2Id, `SELECT id FROM public.memory_entries WHERE id = '${sharedMemId}'`);
      expect(resA2.length).toBe(1);

      // Cross-tenant user B1 CANNOT see shared memory
      const resB1 = await db.queryAsUser(userB1Id, `SELECT id FROM public.memory_entries WHERE id = '${sharedMemId}'`);
      expect(resB1.length).toBe(0);
    });
  });

  // ===========================================================================
  // SECTION 8: AUDIT LOG IMMUTABILITY & PROVENANCE
  // ===========================================================================
  describe('8. Audit Log Security & Provenance', () => {
    it('verifies audit logs cannot be updated or deleted by normal users', async () => {
      const logId = 'aaaaaaaa-7777-4111-a777-777777777777';
      await db.executeAsAdmin(`
        INSERT INTO public.audit_logs (id, workspace_id, actor_user_id, action_type, metadata)
        VALUES ('${logId}', '${wsA1Id}', '${userA1Id}', 'DOCUMENT_DELETE', '{"doc":"spec.pdf"}'::jsonb);
      `);

      // Attempt UPDATE -> 0 rows updated
      await db.executeAsUser(userA1Id, `
        UPDATE public.audit_logs SET action_type = 'DOCUMENT_TAMPERED' WHERE id = '${logId}';
      `);

      const check = await db.queryAsAdmin<{ action_type: string }>(`
        SELECT action_type FROM public.audit_logs WHERE id = '${logId}';
      `);
      expect(check[0].action_type).toBe('DOCUMENT_DELETE');

      // Attempt DELETE -> 0 rows deleted
      await db.executeAsUser(userA1Id, `
        DELETE FROM public.audit_logs WHERE id = '${logId}';
      `);

      const count = await db.queryAsAdmin<{ cnt: number }>(`
        SELECT count(*)::int as cnt FROM public.audit_logs WHERE id = '${logId}';
      `);
      expect(count[0].cnt).toBe(1);
    });

    it('rejects audit log insertion where actor_user_id does not match auth.uid()', async () => {
      const res = await db.executeAsUser(userA1Id, `
        INSERT INTO public.audit_logs (workspace_id, actor_user_id, action_type)
        VALUES ('${wsA1Id}', '${userA2Id}', 'FORGED_AUDIT');
      `);
      expect(res.exitCode).not.toBe(0);
      expect(res.error).toMatch(/violates row-level security policy/);
    });
  });

  // ===========================================================================
  // SECTION 9: REAL POSTGREST HTTP VERIFICATION WITH SIGNED JWTS
  // ===========================================================================
  describe('9. Real PostgREST HTTP Endpoints with Signed Bearer Tokens', () => {
    it('verifies PostgREST GET /workspaces with User A1 JWT returns only Workspace Alpha entities', async () => {
      const jwtA1 = await generateJwt(userA1Id, 'admin.a1@alpha.com');

      const response = await fetch(`${SUPABASE_REST_URL}/workspaces?select=id,name,organization_id`, {
        headers: {
          apikey: ANON_KEY,
          Authorization: `Bearer ${jwtA1}`,
        },
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as Array<{ id: string; name: string; organization_id: string }>;
      expect(data.length).toBe(1);
      expect(data[0].id).toBe(wsA1Id);
      expect(data[0].organization_id).toBe(orgAId);
    });

    it('verifies PostgREST IDOR direct query returns empty array [] (anti-enumeration)', async () => {
      const jwtA1 = await generateJwt(userA1Id, 'admin.a1@alpha.com');

      const response = await fetch(`${SUPABASE_REST_URL}/workspaces?id=eq.${wsB1Id}&select=id,name`, {
        headers: {
          apikey: ANON_KEY,
          Authorization: `Bearer ${jwtA1}`,
        },
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as Array<{ id: string; name: string }>;
      expect(data.length).toBe(0); // RLS filtered out
    });

    it('verifies PostgREST POST /rpc/bootstrap_workspace creates workspace under authenticated caller', async () => {
      const jwtFresh = await generateJwt(userFreshId, 'fresh@gamma.com');

      const response = await fetch(`${SUPABASE_REST_URL}/rpc/bootstrap_workspace`, {
        method: 'POST',
        headers: {
          apikey: ANON_KEY,
          Authorization: `Bearer ${jwtFresh}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_name: 'PostgREST Gamma WS' }),
      });

      expect(response.status).toBe(200);
      const newWsId = await response.json();
      expect(typeof newWsId).toBe('string');

      // Verify in DB
      const ws = await db.queryAsAdmin<{ organization_id: string; name: string }>(`
        SELECT organization_id, name FROM public.workspaces WHERE id = '${newWsId}';
      `);
      expect(ws[0].organization_id).toBe(orgCId);
      expect(ws[0].name).toBe('PostgREST Gamma WS');
    });
  });
});

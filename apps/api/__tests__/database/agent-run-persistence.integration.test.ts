import { PostgresTestClient } from './test-client.js';

describe('N3.4: Agent Run Persistence & Database Transaction Integration', () => {
  const db = new PostgresTestClient();

  const ORG_A_ID = '11111111-1111-4111-a111-111111111111';
  const ORG_B_ID = '22222222-2222-4222-a222-222222222222';
  const WS_A_ID = '33333333-3333-4333-a333-333333333333';
  const WS_B_ID = '44444444-4444-4444-a444-444444444444';
  const USER_A_ID = '55555555-5555-4555-a555-555555555555';
  const USER_B_ID = '66666666-6666-4666-a666-666666666666';
  const THREAD_A_ID = '77777777-7777-4777-a777-777777777777';
  const THREAD_B_ID = '88888888-8888-4888-a888-888888888888';

  beforeEach(async () => {
    await db.cleanAllTables();

    // Seed orgs
    await db.executeAsAdmin(`
      INSERT INTO public.organizations (id, name) VALUES
      ('${ORG_A_ID}', 'Org A'),
      ('${ORG_B_ID}', 'Org B');
    `);

    // Seed auth users & profiles
    await db.seedAuthUser(USER_A_ID, 'userA@test.com');
    await db.seedAuthUser(USER_B_ID, 'userB@test.com');

    await db.executeAsAdmin(`
      INSERT INTO public.users (id, organization_id, email, full_name) VALUES
      ('${USER_A_ID}', '${ORG_A_ID}', 'userA@test.com', 'User A'),
      ('${USER_B_ID}', '${ORG_B_ID}', 'userB@test.com', 'User B');
    `);

    // Seed workspaces
    await db.executeAsAdmin(`
      INSERT INTO public.workspaces (id, organization_id, name) VALUES
      ('${WS_A_ID}', '${ORG_A_ID}', 'Workspace A'),
      ('${WS_B_ID}', '${ORG_B_ID}', 'Workspace B');
    `);

    // Seed workspace memberships
    await db.executeAsAdmin(`
      INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
      ('${WS_A_ID}', '${USER_A_ID}', 'contributor'),
      ('${WS_B_ID}', '${USER_B_ID}', 'contributor');
    `);

    // Seed threads
    await db.executeAsAdmin(`
      INSERT INTO public.threads (id, workspace_id, created_by, title) VALUES
      ('${THREAD_A_ID}', '${WS_A_ID}', '${USER_A_ID}', 'Thread A'),
      ('${THREAD_B_ID}', '${WS_B_ID}', '${USER_B_ID}', 'Thread B');
    `);
  });

  afterAll(async () => {
    await db.cleanAllTables();
  });

  // ==========================================================================
  // 1. ATOMIC TURN CREATION: create_agent_run_turn
  // ==========================================================================
  describe('1. Atomic Turn Creation (create_agent_run_turn)', () => {
    it('should atomically create user message and agent_runs row in one transaction', async () => {
      const RUN_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
      const result = await db.queryAsUser(
        USER_A_ID,
        `SELECT * FROM public.create_agent_run_turn(
          '${THREAD_A_ID}'::uuid,
          'What is the company policy?'::text,
          '${RUN_ID}'::uuid,
          'corr-123'::varchar
        );`,
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(RUN_ID);
      expect(result[0].workspace_id).toBe(WS_A_ID);
      expect(result[0].thread_id).toBe(THREAD_A_ID);
      expect(result[0].user_id).toBe(USER_A_ID);
      expect(result[0].status).toBe('accepted');
      expect(result[0].initiating_message_id).toBeDefined();

      // Verify initiating user message in DB
      const messages = await db.queryAsAdmin(
        `SELECT * FROM public.messages WHERE id = '${result[0].initiating_message_id}'::uuid;`,
      );
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('What is the company policy?');
      expect(messages[0].user_id).toBe(USER_A_ID);
      expect(messages[0].workspace_id).toBe(WS_A_ID);
    });

    it('should reject turn creation if user does not belong to thread workspace (tenant isolation)', async () => {
      const RUN_ID = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
      // User A attempts to create turn in Thread B (Workspace B)
      const res = await db.executeAsUser(
        USER_A_ID,
        `SELECT * FROM public.create_agent_run_turn(
          '${THREAD_B_ID}'::uuid,
          'Malicious query'::text,
          '${RUN_ID}'::uuid
        );`,
      );

      expect(res.exitCode).not.toBe(0);
      expect(res.error).toMatch(/FORBIDDEN_OR_NOT_FOUND|42501/);

      // Verify ZERO rows were persisted in messages or agent_runs
      const runs = await db.queryAsAdmin(`SELECT * FROM public.agent_runs WHERE id = '${RUN_ID}'::uuid;`);
      expect(runs).toHaveLength(0);
    });
  });

  // ==========================================================================
  // 2. STATE TRANSITIONS & ROW LOCKING: transition_agent_run_status
  // ==========================================================================
  describe('2. State Transitions & Concurrency (transition_agent_run_status)', () => {
    const RUN_ID = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';

    beforeEach(async () => {
      await db.queryAsUser(
        USER_A_ID,
        `SELECT * FROM public.create_agent_run_turn(
          '${THREAD_A_ID}'::uuid,
          'Initial test query'::text,
          '${RUN_ID}'::uuid
        );`,
      );
    });

    it('should successfully transition accepted -> running', async () => {
      const result = await db.queryAsUser(
        USER_A_ID,
        `SELECT * FROM public.transition_agent_run_status(
          '${RUN_ID}'::uuid,
          'accepted'::varchar,
          'running'::varchar
        );`,
      );

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('running');
    });

    it('should reject transition if from_status does not match current state (conflict)', async () => {
      const res = await db.executeAsUser(
        USER_A_ID,
        `SELECT * FROM public.transition_agent_run_status(
          '${RUN_ID}'::uuid,
          'running'::varchar,
          'completed'::varchar
        );`,
      );

      expect(res.exitCode).not.toBe(0);
      expect(res.error).toMatch(/CONFLICT/);
    });
  });

  // ==========================================================================
  // 3. ATOMIC TERMINAL COMMITMENT: commit_agent_run_response
  // ==========================================================================
  describe('3. Atomic Terminal Commitment (commit_agent_run_response)', () => {
    const RUN_ID = 'dddddddd-dddd-4ddd-dddd-dddddddddddd';

    beforeEach(async () => {
      await db.queryAsUser(
        USER_A_ID,
        `SELECT * FROM public.create_agent_run_turn(
          '${THREAD_A_ID}'::uuid,
          'Explain photosynthesis'::text,
          '${RUN_ID}'::uuid
        );`,
      );
      await db.queryAsUser(
        USER_A_ID,
        `SELECT * FROM public.transition_agent_run_status(
          '${RUN_ID}'::uuid,
          'accepted'::varchar,
          'running'::varchar
        );`,
      );
    });

    it('should atomically persist assistant message and update run to completed', async () => {
      const result = await db.queryAsUser(
        USER_A_ID,
        `SELECT * FROM public.commit_agent_run_response(
          '${RUN_ID}'::uuid,
          'completed'::varchar,
          'Photosynthesis is the process...'::text,
          '[{"claimId": "c1", "evidenceId": "e1"}]'::jsonb,
          0.95::float
        );`,
      );

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('completed');
      expect(result[0].assistant_message_id).toBeDefined();
      expect(result[0].completed_at).toBeDefined();
      expect(result[0].verification_confidence_score).toBe(0.95);

      // Verify assistant message in DB
      const messages = await db.queryAsAdmin(
        `SELECT * FROM public.messages WHERE id = '${result[0].assistant_message_id}'::uuid;`,
      );
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('assistant');
      expect(messages[0].user_id).toBeNull();
      expect(messages[0].content).toBe('Photosynthesis is the process...');
    });

    it('should fail and NOT create assistant message on status failed', async () => {
      const result = await db.queryAsUser(
        USER_A_ID,
        `SELECT * FROM public.commit_agent_run_response(
          '${RUN_ID}'::uuid,
          'failed'::varchar,
          NULL,
          '[]'::jsonb,
          NULL
        );`,
      );

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('failed');
      expect(result[0].assistant_message_id).toBeNull();

      // Ensure ONLY initiating user message exists
      const messages = await db.queryAsAdmin(
        `SELECT * FROM public.messages WHERE thread_id = '${THREAD_A_ID}'::uuid;`,
      );
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('user');
    });

    it('should reject attempting to attach assistant message to status failed', async () => {
      const res = await db.executeAsUser(
        USER_A_ID,
        `SELECT * FROM public.commit_agent_run_response(
          '${RUN_ID}'::uuid,
          'failed'::varchar,
          'Should not be created'::text
        );`,
      );

      expect(res.exitCode).not.toBe(0);
      expect(res.error).toMatch(/INVARIANT_VIOLATION/);
    });
  });

  // ==========================================================================
  // 4. AGENT RUN STEPS APPEND-ONLY AUDIT
  // ==========================================================================
  describe('4. Agent Run Steps Append-Only Audit Trail', () => {
    const RUN_ID = 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee';

    beforeEach(async () => {
      await db.queryAsUser(
        USER_A_ID,
        `SELECT * FROM public.create_agent_run_turn(
          '${THREAD_A_ID}'::uuid,
          'Audit test query'::text,
          '${RUN_ID}'::uuid
        );`,
      );
    });

    it('should insert granular steps linked to run and workspace', async () => {
      const STEP_ID = 'ffffffff-ffff-4fff-ffff-ffffffffffff';
      const res = await db.executeAsUser(
        USER_A_ID,
        `INSERT INTO public.agent_run_steps (
          id,
          agent_run_id,
          workspace_id,
          agent_name,
          node_name,
          input_payload,
          output_payload,
          duration_ms
        ) VALUES (
          '${STEP_ID}'::uuid,
          '${RUN_ID}'::uuid,
          '${WS_A_ID}'::uuid,
          'supervisor',
          'SupervisorNode',
          '{"nodeName": "SupervisorNode", "status": "started", "durationMs": 0}'::jsonb,
          '{"nodeName": "SupervisorNode", "status": "completed", "durationMs": 85}'::jsonb,
          85
        );`,
      );

      expect(res.exitCode).toBe(0);

      const steps = await db.queryAsUser(
        USER_A_ID,
        `SELECT * FROM public.agent_run_steps WHERE agent_run_id = '${RUN_ID}'::uuid;`,
      );
      expect(steps).toHaveLength(1);
      expect(steps[0].id).toBe(STEP_ID);
      expect(steps[0].duration_ms).toBe(85);
    });

    it('should reject step insertion for mismatched workspace (tenancy RLS)', async () => {
      const STEP_ID = '12121212-1212-4212-a212-121212121212';
      // User A attempts to insert step into Workspace B
      const res = await db.executeAsUser(
        USER_A_ID,
        `INSERT INTO public.agent_run_steps (
          id,
          agent_run_id,
          workspace_id,
          agent_name,
          node_name,
          duration_ms
        ) VALUES (
          '${STEP_ID}'::uuid,
          '${RUN_ID}'::uuid,
          '${WS_B_ID}'::uuid,
          'supervisor',
          'SupervisorNode',
          50
        );`,
      );

      expect(res.exitCode).not.toBe(0);
    });
  });
});

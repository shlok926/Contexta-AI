import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { PostgresTestClient } from './test-client.js';

describe('Database Integration Test: Memory Visibility & Lifecycle', () => {
  const db = new PostgresTestClient();

  const user1Id = 'aaaaaaaa-1111-4000-a000-111111111111';
  const user2Id = 'bbbbbbbb-2222-4000-b000-222222222222';
  let wsId: string;

  beforeEach(async () => {
    await db.cleanAllTables();

    // Create Organization and Workspace
    const seeded = await db.seedOrgAndAdmin('Memory Org', 'user1@example.com', user1Id, 'Memory Workspace');
    wsId = seeded.wsId;

    // Add User 2 to the same workspace as contributor
    await db.seedAuthUser(user2Id, 'user2@example.com');
    await db.executeAsAdmin(`
      INSERT INTO public.users (id, organization_id, email, full_name)
      VALUES ('${user2Id}', '${seeded.orgId}', 'user2@example.com', 'User Two');

      INSERT INTO public.workspace_members (workspace_id, user_id, role)
      VALUES ('${wsId}', '${user2Id}', 'contributor');
    `);
  });

  afterAll(async () => {
    await db.cleanAllTables();
  });

  it('enforces user_private memory visibility: only author can see, co-member cannot', async () => {
    // User 1 inserts a private memory entry
    const insertRes = await db.executeAsUser(user1Id, `
      INSERT INTO public.memory_entries (
        workspace_id, user_id, visibility, memory_type, content, reason
      ) VALUES (
        '${wsId}', '${user1Id}', 'user_private', 'user_preference', 'Prefers dark mode', 'Extracted from user message'
      );
    `);
    expect(insertRes.exitCode).toBe(0);

    // User 1 queries: can see private entry
    const user1Memories = await db.queryAsUser(user1Id, `
      SELECT content, visibility FROM public.memory_entries;
    `);
    expect(user1Memories.length).toBe(1);
    expect(user1Memories[0].content).toBe('Prefers dark mode');

    // User 2 queries: cannot see User 1's private entry
    const user2Memories = await db.queryAsUser(user2Id, `
      SELECT content, visibility FROM public.memory_entries;
    `);
    expect(user2Memories.length).toBe(0);
  });

  it('allows co-member to see workspace_shared memory', async () => {
    // User 1 inserts a workspace_shared memory entry
    await db.executeAsUser(user1Id, `
      INSERT INTO public.memory_entries (
        workspace_id, user_id, visibility, memory_type, content, reason
      ) VALUES (
        '${wsId}', '${user1Id}', 'workspace_shared', 'project_context', 'Target deployment is Q4', 'Project planning notes'
      );
    `);

    // User 2 queries: can see workspace_shared entry
    const user2Memories = await db.queryAsUser(user2Id, `
      SELECT content, visibility FROM public.memory_entries;
    `);
    expect(user2Memories.length).toBe(1);
    expect(user2Memories[0].content).toBe('Target deployment is Q4');
    expect(user2Memories[0].visibility).toBe('workspace_shared');
  });

  it('enforces soft deletion: is_deleted = true hides row from normal SELECT', async () => {
    const insertRes = await db.executeAsUser(user1Id, `
      INSERT INTO public.memory_entries (
        id, workspace_id, user_id, visibility, memory_type, content, reason
      ) VALUES (
        '99999999-9999-4999-9999-999999999999', '${wsId}', '${user1Id}', 'user_private', 'explicit_instruction', 'Never share logs', 'Compliance instruction'
      );
    `);
    expect(insertRes.exitCode).toBe(0);

    // Soft delete via UPDATE
    const updateRes = await db.executeAsUser(user1Id, `
      UPDATE public.memory_entries SET is_deleted = true WHERE id = '99999999-9999-4999-9999-999999999999';
    `);
    expect(updateRes.exitCode).toBe(0);

    // Active memory hydration query (WHERE is_deleted = false) returns 0 rows
    const user1Memories = await db.queryAsUser(user1Id, `
      SELECT id FROM public.memory_entries 
      WHERE id = '99999999-9999-4999-9999-999999999999' AND is_deleted = false;
    `);
    expect(user1Memories.length).toBe(0);

    // Co-member (User 2) querying memory_entries cannot see the soft-deleted entry
    const user2Memories = await db.queryAsUser(user2Id, `
      SELECT id FROM public.memory_entries WHERE id = '99999999-9999-4999-9999-999999999999';
    `);
    expect(user2Memories.length).toBe(0);

    // Direct physical DELETE should fail or be blocked by policy
    const deleteRes = await db.executeAsUser(user1Id, `
      DELETE FROM public.memory_entries WHERE id = '99999999-9999-4999-9999-999999999999';
    `);
    // DELETE policy does not exist for authenticated role, so 0 rows are deleted
    const adminCheck = await db.queryAsAdmin(`
      SELECT is_deleted FROM public.memory_entries WHERE id = '99999999-9999-4999-9999-999999999999';
    `);
    expect(adminCheck.length).toBe(1);
    expect(adminCheck[0].is_deleted).toBe(true);
  });
});

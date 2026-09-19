import { spawn } from 'child_process';

export interface SqlResult<T = any> {
  stdout: string;
  stderr: string;
  exitCode: number;
  data?: T;
  error?: string;
}

export class PostgresTestClient {
  private containerName: string;

  constructor(containerName = 'supabase_db_ContextaAI') {
    this.containerName = containerName;
  }

  public async rawQuery(sql: string): Promise<SqlResult> {
    return new Promise((resolve) => {
      const psql = spawn('docker', [
        'exec',
        '-i',
        this.containerName,
        'psql',
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        '-t',
        '-A',
      ]);

      let stdout = '';
      let stderr = '';

      psql.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      psql.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      psql.on('close', (exitCode) => {
        const code = exitCode ?? 0;
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: code,
          error: code !== 0 ? stderr.trim() || stdout.trim() : undefined,
        });
      });

      psql.stdin.write(sql);
      psql.stdin.end();
    });
  }

  public async executeAsAdmin(sql: string): Promise<SqlResult> {
    const res = await this.rawQuery(sql);
    if (res.exitCode !== 0) {
      throw new Error(`executeAsAdmin failed (code ${res.exitCode}): ${res.stderr || res.stdout}`);
    }
    return res;
  }

  public async queryAsAdmin<T = any>(sql: string): Promise<T[]> {
    const cleanSql = sql.trim().replace(/;$/, '');
    const wrapped = `
      WITH q_sub AS (
        ${cleanSql}
      )
      SELECT COALESCE(json_agg(q_sub), '[]'::json) FROM q_sub;
    `;
    const res = await this.rawQuery(wrapped);
    if (res.exitCode !== 0) {
      throw new Error(`Admin query failed (code ${res.exitCode}): ${res.stderr || res.stdout}`);
    }
    try {
      const match = res.stdout.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        return Array.isArray(parsed) ? parsed : [parsed];
      }
      return JSON.parse(res.stdout);
    } catch {
      return [] as T[];
    }
  }

  public async queryAsUser<T = any>(userId: string, sql: string): Promise<T[]> {
    const cleanSql = sql.trim().replace(/;$/, '');
    const wrapped = `
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL "request.jwt.claims" = '{"sub": "${userId}", "role": "authenticated"}';
      WITH q_sub AS (
        ${cleanSql}
      )
      SELECT COALESCE(json_agg(q_sub), '[]'::json) FROM q_sub;
      COMMIT;
    `;
    const res = await this.rawQuery(wrapped);
    if (res.exitCode !== 0) {
      throw new Error(`User query failed (code ${res.exitCode}): ${res.stderr || res.stdout}`);
    }
    try {
      const match = res.stdout.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        return Array.isArray(parsed) ? parsed : [parsed];
      }
      return JSON.parse(res.stdout);
    } catch {
      return [] as T[];
    }
  }

  public async executeAsUser(userId: string, sql: string): Promise<SqlResult> {
    const cleanSql = sql.trim().replace(/;$/, '');
    const wrapped = `
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL "request.jwt.claims" = '{"sub": "${userId}", "role": "authenticated"}';
      ${cleanSql};
      COMMIT;
    `;
    return this.rawQuery(wrapped);
  }

  public async cleanAllTables(): Promise<void> {
    const sql = `
      TRUNCATE TABLE 
        public.audit_logs,
        public.citations,
        public.embeddings,
        public.chunks,
        public.document_versions,
        public.documents,
        public.memory_entries,
        public.agent_run_steps,
        public.agent_runs,
        public.messages,
        public.threads,
        public.workspace_members,
        public.workspaces,
        public.users,
        public.organizations
      CASCADE;
      DELETE FROM auth.users;
    `;
    const res = await this.rawQuery(sql);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to clean tables: ${res.error}`);
    }
  }

  public async seedAuthUser(id: string, email: string): Promise<void> {
    const sql = `
      INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at, role, aud)
      VALUES ('${id}', '${email}', '{}'::jsonb, now(), now(), 'authenticated', 'authenticated')
      ON CONFLICT (id) DO NOTHING;
    `;
    const res = await this.rawQuery(sql);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to seed auth.user: ${res.error}`);
    }
  }

  public async seedOrgAndAdmin(orgName: string, adminEmail: string, adminId: string, wsName: string): Promise<{ orgId: string; wsId: string }> {
    await this.seedAuthUser(adminId, adminEmail);
    const sql = `
      WITH new_org AS (
        INSERT INTO public.organizations (name) VALUES ('${orgName}') RETURNING id
      ),
      new_user AS (
        INSERT INTO public.users (id, organization_id, email, full_name)
        SELECT '${adminId}', id, '${adminEmail}', 'Admin User' FROM new_org RETURNING id, organization_id
      ),
      new_ws AS (
        INSERT INTO public.workspaces (organization_id, name)
        SELECT organization_id, '${wsName}' FROM new_user RETURNING id
      ),
      new_mem AS (
        INSERT INTO public.workspace_members (workspace_id, user_id, role)
        SELECT w.id, u.id, 'org_admin'
        FROM new_ws w, new_user u
        RETURNING workspace_id
      )
      SELECT json_build_object('orgId', u.organization_id, 'wsId', w.id) as result
      FROM new_ws w, new_user u, new_mem m;
    `;
    const res = await this.rawQuery(sql);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to seed org and admin: ${res.error}`);
    }
    const lines = res.stdout.split('\n').map(l => l.trim()).filter(l => l.startsWith('{'));
    const parsed = JSON.parse(lines[lines.length - 1]);
    return parsed;
  }
}

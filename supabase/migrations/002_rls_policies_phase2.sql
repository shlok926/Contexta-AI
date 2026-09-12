-- Enable RLS on newly identified missing tables
ALTER TABLE memory_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE citations ENABLE ROW LEVEL SECURITY;

-- memory_entries RLS
-- Explicitly isolated by both workspace_id AND user_id as it's user-specific
CREATE POLICY workspace_isolation_select_memory_entries ON memory_entries
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid()
    )
    AND user_id = auth.uid()
  );

CREATE POLICY workspace_isolation_insert_memory_entries ON memory_entries
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid()
    )
    AND user_id = auth.uid()
  );

CREATE POLICY workspace_isolation_delete_memory_entries ON memory_entries
  FOR DELETE
  USING (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid()
    )
    AND user_id = auth.uid()
  );


-- agent_runs RLS
CREATE POLICY workspace_isolation_select_agent_runs ON agent_runs
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid()
    )
  );

CREATE POLICY workspace_isolation_insert_agent_runs ON agent_runs
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid()
    )
  );

CREATE POLICY workspace_isolation_update_agent_runs ON agent_runs
  FOR UPDATE
  USING (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid()
    )
  );


-- agent_run_steps RLS (linked to agent_runs)
CREATE POLICY workspace_isolation_select_agent_run_steps ON agent_run_steps
  FOR SELECT
  USING (
    agent_run_id IN (
      SELECT r.id FROM agent_runs r
      WHERE r.workspace_id IN (
        SELECT workspace_id FROM workspace_members
        WHERE user_id = auth.uid()
      )
    )
  );

CREATE POLICY workspace_isolation_insert_agent_run_steps ON agent_run_steps
  FOR INSERT
  WITH CHECK (
    agent_run_id IN (
      SELECT r.id FROM agent_runs r
      WHERE r.workspace_id IN (
        SELECT workspace_id FROM workspace_members
        WHERE user_id = auth.uid()
      )
    )
  );


-- citations RLS (linked to agent_runs)
CREATE POLICY workspace_isolation_select_citations ON citations
  FOR SELECT
  USING (
    agent_run_id IN (
      SELECT r.id FROM agent_runs r
      WHERE r.workspace_id IN (
        SELECT workspace_id FROM workspace_members
        WHERE user_id = auth.uid()
      )
    )
  );

CREATE POLICY workspace_isolation_insert_citations ON citations
  FOR INSERT
  WITH CHECK (
    agent_run_id IN (
      SELECT r.id FROM agent_runs r
      WHERE r.workspace_id IN (
        SELECT workspace_id FROM workspace_members
        WHERE user_id = auth.uid()
      )
    )
  );

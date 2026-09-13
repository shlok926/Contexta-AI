-- Enable RLS on core tables
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE embeddings ENABLE ROW LEVEL SECURITY;

-- Layer 2 Enforcement: workspace_isolation_select
-- Ensures that a query to vector/chunk tables only returns rows if the authenticated user
-- belongs to the corresponding workspace.
CREATE POLICY workspace_isolation_select_documents ON documents
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid()
    )
  );

CREATE POLICY workspace_isolation_select_chunks ON chunks
  FOR SELECT
  USING (
    document_version_id IN (
      SELECT dv.id FROM document_versions dv
      JOIN documents d ON dv.document_id = d.id
      WHERE d.workspace_id IN (
        SELECT workspace_id FROM workspace_members
        WHERE user_id = auth.uid()
      )
    )
  );

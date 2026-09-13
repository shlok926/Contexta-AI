-- ============================================================================
-- Contexta-AI Phase 1: Canonical 15-Entity Database Baseline
-- File: supabase/migrations/20260912000000_canonical_15_entity_baseline.sql
-- Governed by: ADR-0001 through ADR-0009 (Frozen)
-- Authoritative Specification: docs/implementation/PHASE-01_DATABASE_IMPLEMENTATION_SPEC.md
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Extensions Initialization
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA extensions;

-- Ensure search path includes extensions and public
SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 2. Master 15-Entity Relational Schema (Topological Order)
-- ----------------------------------------------------------------------------

-- Entity 1: organizations (Root Enterprise & Billing Entity)
CREATE TABLE IF NOT EXISTS public.organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Entity 2: users (Profile Extension linked to auth.users)
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    email VARCHAR(320) NOT NULL UNIQUE,
    full_name VARCHAR(255) NULL,
    avatar_url TEXT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Entity 3: workspaces (Authoritative Physical Tenant Boundary)
CREATE TABLE IF NOT EXISTS public.workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    name VARCHAR(255) NOT NULL,
    description TEXT NULL,
    retention_policy VARCHAR(50) NOT NULL DEFAULT 'standard',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Entity 4: workspace_members (Workspace Tenancy Membership & RBAC)
CREATE TABLE IF NOT EXISTS public.workspace_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    role VARCHAR(30) NOT NULL CHECK (role IN ('viewer', 'contributor', 'workspace_admin', 'org_admin')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_workspace_members_ws_user UNIQUE (workspace_id, user_id)
);

-- Entity 5: threads (Conversational Session Container)
CREATE TABLE IF NOT EXISTS public.threads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    title VARCHAR(500) NOT NULL DEFAULT 'New Conversation',
    is_deleted BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Entity 6: messages (Linear Conversational Turn History)
CREATE TABLE IF NOT EXISTS public.messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES public.threads(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    user_id UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    citations JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Entity 7: agent_runs (Agent Execution Run Tracking)
CREATE TABLE IF NOT EXISTS public.agent_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    thread_id UUID NOT NULL REFERENCES public.threads(id) ON DELETE CASCADE,
    initiating_message_id UUID NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
    assistant_message_id UUID NULL REFERENCES public.messages(id) ON DELETE SET NULL,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    correlation_id VARCHAR(64) NOT NULL,
    query TEXT NOT NULL,
    status VARCHAR(30) NOT NULL CHECK (status IN ('accepted', 'running', 'completed', 'declined_uncertain', 'failed', 'cancelled')),
    verification_confidence_score FLOAT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ NULL
);

-- Entity 8: agent_run_steps (Granular Agent Workflow Node Execution Trace)
CREATE TABLE IF NOT EXISTS public.agent_run_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_run_id UUID NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    agent_name VARCHAR(50) NOT NULL,
    node_name VARCHAR(50) NOT NULL,
    input_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    output_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    duration_ms INT NOT NULL,
    executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Entity 9: audit_logs (Security & Operational Event Ledger)
CREATE TABLE IF NOT EXISTS public.audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NULL REFERENCES public.workspaces(id) ON DELETE SET NULL,
    actor_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    action_type VARCHAR(50) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Entity 10: documents (Logical Document Entity)
CREATE TABLE IF NOT EXISTS public.documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    uploaded_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    title VARCHAR(500) NOT NULL,
    source_type VARCHAR(50) NOT NULL,
    s3_object_key VARCHAR(1024) NOT NULL,
    is_deleted BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Entity 11: document_versions (Immutable Ingestion Run Lineage)
CREATE TABLE IF NOT EXISTS public.document_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    version_number INT NOT NULL,
    status VARCHAR(30) NOT NULL CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
    is_current BOOLEAN NOT NULL DEFAULT false,
    is_superseded BOOLEAN NOT NULL DEFAULT false,
    ingested_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_document_versions_doc_ver UNIQUE (document_id, version_number)
);

-- Entity 12: chunks (Extracted Structure-Aware Text Units)
CREATE TABLE IF NOT EXISTS public.chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_version_id UUID NOT NULL REFERENCES public.document_versions(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    chunk_offset INT NOT NULL,
    content TEXT NOT NULL,
    token_count INT NOT NULL,
    tsv_content TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Entity 13: embeddings (Dense Vector Index Target)
CREATE TABLE IF NOT EXISTS public.embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chunk_id UUID NOT NULL REFERENCES public.chunks(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    embedding_vector VECTOR(1536) NOT NULL,
    model_name VARCHAR(100) NOT NULL DEFAULT 'text-embedding-3-small',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Entity 14: citations (Extracted Factual Claims & Entailment Verification)
CREATE TABLE IF NOT EXISTS public.citations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_run_id UUID NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    chunk_id UUID NULL REFERENCES public.chunks(id) ON DELETE SET NULL,
    claim_text TEXT NOT NULL,
    verification_status VARCHAR(40) NOT NULL CHECK (verification_status IN (
        'SUPPORTED', 'NOT_SUPPORTED', 'CONTRADICTED',
        'CONFLICTING_EVIDENCE', 'INSUFFICIENT_EVIDENCE', 'VERIFICATION_FAILED'
    )),
    stage1_passed BOOLEAN NOT NULL,
    stage2_entailment_score FLOAT NULL,
    page_number INT NULL,
    char_span INT[] NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Entity 15: memory_entries (Unified Contextual Long-Term Memory)
CREATE TABLE IF NOT EXISTS public.memory_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    visibility VARCHAR(30) NOT NULL CHECK (visibility IN ('user_private', 'workspace_shared')),
    memory_type VARCHAR(50) NOT NULL CHECK (memory_type IN ('user_preference', 'project_context', 'explicit_instruction')),
    content TEXT NOT NULL,
    confidence FLOAT NOT NULL DEFAULT 1.0,
    source_agent VARCHAR(50) NOT NULL DEFAULT 'memory_agent',
    reason TEXT NOT NULL,
    is_deleted BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 3. Performance & Relational Indices
-- ----------------------------------------------------------------------------

-- Vector Index: HNSW Cosine Distance (Physical performance optimization decoupled from RLS)
CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw_cosine 
ON public.embeddings 
USING hnsw (embedding_vector vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Vector Tenancy Pre-filter Composite Index
CREATE INDEX IF NOT EXISTS idx_embeddings_workspace_chunk 
ON public.embeddings (workspace_id, chunk_id);

-- Sparse Search Index: Full Text Search GIN
CREATE INDEX IF NOT EXISTS idx_chunks_tsv 
ON public.chunks 
USING gin (tsv_content);

-- Sparse Tenancy Pre-filter Composite Index
CREATE INDEX IF NOT EXISTS idx_chunks_workspace_version 
ON public.chunks (workspace_id, document_version_id);

-- Workspace Membership Fast Lookup for RLS
CREATE INDEX IF NOT EXISTS idx_ws_members_user_ws 
ON public.workspace_members (user_id, workspace_id);

-- Document Version Partial Unique Index: At most one current version per document
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_versions_current 
ON public.document_versions (document_id) 
WHERE is_current = true;

-- Document Version Status Composite Index
CREATE INDEX IF NOT EXISTS idx_doc_versions_ws_status 
ON public.document_versions (workspace_id, status, is_current);

-- Memory Entries Fast Pre-Route Hydration Index
CREATE INDEX IF NOT EXISTS idx_memory_ws_user_vis 
ON public.memory_entries (workspace_id, user_id, visibility) 
WHERE is_deleted = false;

-- Threads Workspace Pagination Index
CREATE INDEX IF NOT EXISTS idx_threads_ws_created 
ON public.threads (workspace_id, created_at DESC) 
WHERE is_deleted = false;

-- Messages Thread History Index
CREATE INDEX IF NOT EXISTS idx_messages_thread_created 
ON public.messages (thread_id, created_at ASC);

-- Agent Runs Thread History Index
CREATE INDEX IF NOT EXISTS idx_agent_runs_thread_created 
ON public.agent_runs (thread_id, started_at DESC);

-- Agent Runs Workspace Pagination Index
CREATE INDEX IF NOT EXISTS idx_agent_runs_ws_started 
ON public.agent_runs (workspace_id, started_at DESC);

-- Agent Run Steps Execution Trace Index
CREATE INDEX IF NOT EXISTS idx_run_steps_run_executed 
ON public.agent_run_steps (agent_run_id, executed_at ASC);

-- Citations Run Claim Index
CREATE INDEX IF NOT EXISTS idx_citations_run_claim 
ON public.citations (agent_run_id, verification_status);

-- Audit Logs Workspace Chronological Index
CREATE INDEX IF NOT EXISTS idx_audit_logs_ws_occurred 
ON public.audit_logs (workspace_id, occurred_at DESC);

-- ----------------------------------------------------------------------------
-- 4. Consistency, Lineage & Immutability Triggers
-- ----------------------------------------------------------------------------

-- Trigger 1: Chunk Workspace Lineage Integrity
CREATE OR REPLACE FUNCTION public.enforce_chunk_workspace_integrity()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM (SELECT workspace_id FROM public.document_versions WHERE id = NEW.document_version_id) THEN
    RAISE EXCEPTION 'Tenancy integrity violation: chunk workspace_id does not match document_version workspace';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_chunk_workspace_integrity
BEFORE INSERT OR UPDATE ON public.chunks
FOR EACH ROW EXECUTE FUNCTION public.enforce_chunk_workspace_integrity();

-- Trigger 2: Embedding Workspace Lineage Integrity
CREATE OR REPLACE FUNCTION public.enforce_embedding_workspace_integrity()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM (SELECT workspace_id FROM public.chunks WHERE id = NEW.chunk_id) THEN
    RAISE EXCEPTION 'Tenancy integrity violation: embedding workspace_id does not match chunk workspace';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_embedding_workspace_integrity
BEFORE INSERT OR UPDATE ON public.embeddings
FOR EACH ROW EXECUTE FUNCTION public.enforce_embedding_workspace_integrity();

-- Trigger 3: Immutable workspace_id on child entities (NULL-safe IS DISTINCT FROM)
CREATE OR REPLACE FUNCTION public.enforce_workspace_id_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.workspace_id IS NOT NULL AND NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION 'Security violation: workspace_id is strictly immutable once persisted';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply strictly to child entities carrying workspace_id (workspaces table excluded because its PK is id)
CREATE TRIGGER trg_immutability_workspace_members BEFORE UPDATE ON public.workspace_members FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_id_immutability();
CREATE TRIGGER trg_immutability_threads BEFORE UPDATE ON public.threads FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_id_immutability();
CREATE TRIGGER trg_immutability_messages BEFORE UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_id_immutability();
CREATE TRIGGER trg_immutability_agent_runs BEFORE UPDATE ON public.agent_runs FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_id_immutability();
CREATE TRIGGER trg_immutability_agent_run_steps BEFORE UPDATE ON public.agent_run_steps FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_id_immutability();
CREATE TRIGGER trg_immutability_documents BEFORE UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_id_immutability();
CREATE TRIGGER trg_immutability_document_versions BEFORE UPDATE ON public.document_versions FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_id_immutability();
CREATE TRIGGER trg_immutability_chunks BEFORE UPDATE ON public.chunks FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_id_immutability();
CREATE TRIGGER trg_immutability_embeddings BEFORE UPDATE ON public.embeddings FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_id_immutability();
CREATE TRIGGER trg_immutability_citations BEFORE UPDATE ON public.citations FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_id_immutability();
CREATE TRIGGER trg_immutability_memory_entries BEFORE UPDATE ON public.memory_entries FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_id_immutability();

-- Trigger 4: Automatic updated_at timestamp maintenance
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_organizations_updated_at BEFORE UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_update_users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_update_workspaces_updated_at BEFORE UPDATE ON public.workspaces FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_update_threads_updated_at BEFORE UPDATE ON public.threads FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_update_documents_updated_at BEFORE UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_update_memory_entries_updated_at BEFORE UPDATE ON public.memory_entries FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ----------------------------------------------------------------------------
-- 5. Non-Recursive RLS Helper Functions (Zero-Argument SECURITY DEFINER)
-- ----------------------------------------------------------------------------

-- Helper 1: Non-recursive resolution of authenticated caller's workspace IDs
CREATE OR REPLACE FUNCTION public.get_authenticated_user_workspace_ids()
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid();
$$;

REVOKE EXECUTE ON FUNCTION public.get_authenticated_user_workspace_ids() FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_authenticated_user_workspace_ids() TO authenticated;

-- Helper 2: Check if authenticated caller holds org_admin role in their organization
CREATE OR REPLACE FUNCTION public.is_authenticated_org_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_members wm
    JOIN public.workspaces w ON w.id = wm.workspace_id
    WHERE wm.user_id = auth.uid() 
      AND wm.role = 'org_admin'
      AND w.organization_id = (SELECT organization_id FROM public.users WHERE id = auth.uid())
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_authenticated_org_admin() FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_authenticated_org_admin() TO authenticated;

-- Helper 3: Non-recursive resolution of authenticated caller's organization_id
CREATE OR REPLACE FUNCTION public.get_authenticated_user_organization_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT organization_id FROM public.users WHERE id = auth.uid();
$$;

REVOKE EXECUTE ON FUNCTION public.get_authenticated_user_organization_id() FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_authenticated_user_organization_id() TO authenticated;

-- Helper 4: Check if authenticated caller is workspace_admin or org_admin for a target workspace
CREATE OR REPLACE FUNCTION public.is_authenticated_workspace_admin_or_org_admin(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_members 
    WHERE workspace_id = p_workspace_id 
      AND user_id = auth.uid() 
      AND role IN ('workspace_admin', 'org_admin')
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_authenticated_workspace_admin_or_org_admin(UUID) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_authenticated_workspace_admin_or_org_admin(UUID) TO authenticated;

-- ----------------------------------------------------------------------------
-- 6. Enable Row-Level Security on All 15 Entities
-- ----------------------------------------------------------------------------

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.citations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_entries ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 7. Authoritative RLS Policies
-- ----------------------------------------------------------------------------

-- Entity 1: organizations
CREATE POLICY p_orgs_select ON public.organizations
  FOR SELECT
  TO authenticated
  USING (id = public.get_authenticated_user_organization_id());

-- Entity 2: users
CREATE POLICY p_users_select ON public.users
  FOR SELECT
  TO authenticated
  USING (
    id = auth.uid() 
    OR organization_id = public.get_authenticated_user_organization_id()
  );

CREATE POLICY p_users_update ON public.users
  FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- Entity 3: workspaces
CREATE POLICY p_workspaces_select ON public.workspaces
  FOR SELECT
  TO authenticated
  USING (id IN (SELECT public.get_authenticated_user_workspace_ids()));

CREATE POLICY p_workspaces_insert ON public.workspaces
  FOR INSERT
  TO authenticated
  WITH CHECK (
    organization_id = public.get_authenticated_user_organization_id() 
    AND public.is_authenticated_org_admin()
  );

CREATE POLICY p_workspaces_update ON public.workspaces
  FOR UPDATE
  TO authenticated
  USING (public.is_authenticated_workspace_admin_or_org_admin(id))
  WITH CHECK (public.is_authenticated_workspace_admin_or_org_admin(id));

-- Entity 4: workspace_members
CREATE POLICY p_members_select ON public.workspace_members
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()));

CREATE POLICY p_members_insert ON public.workspace_members
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_authenticated_workspace_admin_or_org_admin(workspace_id));

CREATE POLICY p_members_delete ON public.workspace_members
  FOR DELETE
  TO authenticated
  USING (public.is_authenticated_workspace_admin_or_org_admin(workspace_id));

-- Entity 5: threads
CREATE POLICY p_threads_select ON public.threads
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()) 
    AND (is_deleted = false OR created_by = auth.uid())
  );

CREATE POLICY p_threads_insert ON public.threads
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()) 
    AND created_by = auth.uid()
  );

CREATE POLICY p_threads_update ON public.threads
  FOR UPDATE
  TO authenticated
  USING (
    workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()) 
    AND created_by = auth.uid()
  )
  WITH CHECK (
    workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()) 
    AND created_by = auth.uid()
  );

-- Entity 6: messages
CREATE POLICY p_messages_select ON public.messages
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()));

CREATE POLICY p_messages_insert ON public.messages
  FOR INSERT
  TO authenticated
  WITH CHECK (workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()));

-- Entity 7: agent_runs
CREATE POLICY p_agent_runs_select ON public.agent_runs
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()));

CREATE POLICY p_agent_runs_insert ON public.agent_runs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()) 
    AND user_id = auth.uid()
  );

CREATE POLICY p_agent_runs_update ON public.agent_runs
  FOR UPDATE
  TO authenticated
  USING (workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()))
  WITH CHECK (workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()));

-- Entity 8: agent_run_steps
CREATE POLICY p_run_steps_select ON public.agent_run_steps
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()));

CREATE POLICY p_run_steps_insert ON public.agent_run_steps
  FOR INSERT
  TO authenticated
  WITH CHECK (workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()));

-- Entity 9: audit_logs
CREATE POLICY p_audit_logs_select ON public.audit_logs
  FOR SELECT
  TO authenticated
  USING (
    (
      workspace_id IS NOT NULL 
      AND workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()) 
      AND public.is_authenticated_workspace_admin_or_org_admin(workspace_id)
    )
    OR
    (
      workspace_id IS NULL 
      AND public.is_authenticated_org_admin() 
      AND actor_user_id IN (
        SELECT id FROM public.users 
        WHERE organization_id = public.get_authenticated_user_organization_id()
      )
    )
  );

CREATE POLICY p_audit_logs_insert ON public.audit_logs
  FOR INSERT
  TO authenticated
  WITH CHECK (actor_user_id = auth.uid());

-- Entity 10: documents
CREATE POLICY p_documents_select ON public.documents
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()) 
    AND (is_deleted = false OR public.is_authenticated_workspace_admin_or_org_admin(workspace_id))
  );

CREATE POLICY p_documents_insert ON public.documents
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()) 
    AND uploaded_by = auth.uid() 
    AND EXISTS (
      SELECT 1 FROM public.workspace_members 
      WHERE workspace_id = documents.workspace_id 
        AND user_id = auth.uid() 
        AND role IN ('contributor', 'workspace_admin', 'org_admin')
    )
  );

CREATE POLICY p_documents_update ON public.documents
  FOR UPDATE
  TO authenticated
  USING (public.is_authenticated_workspace_admin_or_org_admin(workspace_id))
  WITH CHECK (public.is_authenticated_workspace_admin_or_org_admin(workspace_id));

-- Entity 11: document_versions
CREATE POLICY p_doc_versions_select ON public.document_versions
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()));

CREATE POLICY p_doc_versions_insert ON public.document_versions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()) 
    AND EXISTS (
      SELECT 1 FROM public.workspace_members 
      WHERE workspace_id = document_versions.workspace_id 
        AND user_id = auth.uid() 
        AND role IN ('contributor', 'workspace_admin', 'org_admin')
    )
  );

CREATE POLICY p_doc_versions_update ON public.document_versions
  FOR UPDATE
  TO authenticated
  USING (workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()))
  WITH CHECK (workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()));

-- Entity 12: chunks
CREATE POLICY p_chunks_select ON public.chunks
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()));

CREATE POLICY p_chunks_insert ON public.chunks
  FOR INSERT
  TO authenticated
  WITH CHECK (workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()));

-- Entity 13: embeddings
CREATE POLICY p_embeddings_select ON public.embeddings
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()));

CREATE POLICY p_embeddings_insert ON public.embeddings
  FOR INSERT
  TO authenticated
  WITH CHECK (workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()));

-- Entity 14: citations
CREATE POLICY p_citations_select ON public.citations
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()));

CREATE POLICY p_citations_insert ON public.citations
  FOR INSERT
  TO authenticated
  WITH CHECK (workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()));

-- Entity 15: memory_entries
CREATE POLICY p_memory_select ON public.memory_entries
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()) 
    AND (is_deleted = false OR user_id = auth.uid()) 
    AND (user_id = auth.uid() OR visibility = 'workspace_shared')
  );

CREATE POLICY p_memory_insert ON public.memory_entries
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()) 
    AND user_id = auth.uid()
  );

CREATE POLICY p_memory_update ON public.memory_entries
  FOR UPDATE
  TO authenticated
  USING (
    workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()) 
    AND user_id = auth.uid()
  )
  WITH CHECK (
    workspace_id IN (SELECT public.get_authenticated_user_workspace_ids()) 
    AND user_id = auth.uid()
  );

-- Direct physical DELETE is disallowed; memory removal executes through authorized UPDATE is_deleted = true

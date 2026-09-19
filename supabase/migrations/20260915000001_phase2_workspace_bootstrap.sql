-- ============================================================================
-- Migration: 20260915000001_phase2_workspace_bootstrap.sql
-- Description: Ratified SECURITY DEFINER Workspace Bootstrap Primitive
-- Governing Authority: docs/WORKSPACE_BOOTSTRAP_RLS_COMPATIBILITY_DECISION.md
-- ============================================================================

CREATE OR REPLACE FUNCTION public.bootstrap_workspace(
    p_name text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_caller_id uuid;
    v_caller_org_id uuid;
    v_is_active boolean;
    v_workspace_id uuid;
    v_name text;
BEGIN
    -- 1. Resolve and assert caller identity
    v_caller_id := auth.uid();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'UNAUTHENTICATED: Valid JWT session required'
            USING ERRCODE = '42501';
    END IF;

    -- 2. Verify caller existence and active status in public.users
    SELECT u.organization_id, u.is_active
    INTO v_caller_org_id, v_is_active
    FROM public.users u
    WHERE u.id = v_caller_id;

    IF v_caller_org_id IS NULL OR v_is_active IS NOT TRUE THEN
        RAISE EXCEPTION 'FORBIDDEN: Caller must be an active registered user'
            USING ERRCODE = '42501';
    END IF;

    -- 2b. Organization Authority Check (Reconciled from catalog truth where public.users.role does not exist)
    -- [Ratified State B: First-Workspace Bootstrap Policy]
    IF EXISTS (SELECT 1 FROM public.workspaces WHERE organization_id = v_caller_org_id) THEN
        IF NOT public.is_authenticated_org_admin() THEN
            RAISE EXCEPTION 'FORBIDDEN: Caller must hold org_admin role in an existing workspace'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    -- 3. Input validation
    v_name := trim(p_name);

    IF v_name = '' THEN
        RAISE EXCEPTION 'INVALID_PARAMETER: Workspace name must not be empty'
            USING ERRCODE = '22023';
    END IF;

    IF length(v_name) > 255 THEN
        RAISE EXCEPTION 'INVALID_PARAMETER: Workspace name exceeds maximum length of 255 characters'
            USING ERRCODE = '22023';
    END IF;

    -- 4. Server-side UUID generation
    v_workspace_id := gen_random_uuid();

    -- 5. Insert workspace entity
    INSERT INTO public.workspaces (
        id,
        organization_id,
        name,
        description,
        retention_policy,
        created_at,
        updated_at
    ) VALUES (
        v_workspace_id,
        v_caller_org_id,
        v_name,
        NULL,
        'standard',
        now(),
        now()
    );

    -- 6. Insert initial membership row (strictly org_admin for auth.uid())
    INSERT INTO public.workspace_members (
        id,
        workspace_id,
        user_id,
        role,
        joined_at
    ) VALUES (
        gen_random_uuid(),
        v_workspace_id,
        v_caller_id,
        'org_admin',
        now()
    );

    -- 7. Insert audit log entry (Unified audit ownership)
    INSERT INTO public.audit_logs (
        id,
        workspace_id,
        actor_user_id,
        action_type,
        metadata,
        occurred_at
    ) VALUES (
        gen_random_uuid(),
        v_workspace_id,
        v_caller_id,
        'WORKSPACE_BOOTSTRAP',
        jsonb_build_object('name', v_name, 'organization_id', v_caller_org_id),
        now()
    );

    RETURN v_workspace_id;
END;
$$;

-- 8. Hardened privilege grants
REVOKE ALL ON FUNCTION public.bootstrap_workspace(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bootstrap_workspace(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.bootstrap_workspace(text) TO authenticated;

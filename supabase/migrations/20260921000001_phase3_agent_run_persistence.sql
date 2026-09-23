-- ============================================================================
-- Contexta-AI Phase 3: Agent Run Lifecycle & Database Persistence Primitives
-- File: supabase/migrations/20260921000001_phase3_agent_run_persistence.sql
-- Governed by: ADR-0006, ADR-0007 (Frozen)
-- ============================================================================

-- Ensure search path includes extensions and public
SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. Atomic Turn Creation: create_agent_run_turn
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_agent_run_turn(
    p_thread_id UUID,
    p_query TEXT,
    p_run_id UUID DEFAULT gen_random_uuid(),
    p_correlation_id VARCHAR(64) DEFAULT NULL
)
RETURNS TABLE (
    id UUID,
    workspace_id UUID,
    thread_id UUID,
    initiating_message_id UUID,
    assistant_message_id UUID,
    user_id UUID,
    correlation_id VARCHAR(64),
    query TEXT,
    status VARCHAR(30),
    verification_confidence_score FLOAT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_caller_id UUID;
    v_workspace_id UUID;
    v_correlation_id VARCHAR(64);
    v_message_id UUID;
    v_run_id UUID;
BEGIN
    -- 1. Assert authenticated caller
    v_caller_id := auth.uid();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'UNAUTHENTICATED: Valid JWT session required'
            USING ERRCODE = '42501';
    END IF;

    -- 2. Validate thread existence & resolve authorized workspace_id for caller
    SELECT t.workspace_id INTO v_workspace_id
    FROM public.threads t
    JOIN public.workspace_members wm ON wm.workspace_id = t.workspace_id
    WHERE t.id = p_thread_id
      AND wm.user_id = v_caller_id
      AND t.is_deleted = false;

    IF v_workspace_id IS NULL THEN
        RAISE EXCEPTION 'FORBIDDEN_OR_NOT_FOUND: Thread does not exist or caller lacks workspace membership'
            USING ERRCODE = '42501';
    END IF;

    -- 3. Validate query parameter
    IF p_query IS NULL OR trim(p_query) = '' THEN
        RAISE EXCEPTION 'INVALID_PARAMETER: Query must not be empty'
            USING ERRCODE = '22023';
    END IF;

    -- 4. Generate/resolve IDs
    v_message_id := gen_random_uuid();
    v_run_id := COALESCE(p_run_id, gen_random_uuid());

    v_correlation_id := COALESCE(
        p_correlation_id,
        current_setting('request.headers', true)::json->>'x-correlation-id',
        gen_random_uuid()::varchar
    );
    IF length(v_correlation_id) > 64 THEN
        v_correlation_id := substr(v_correlation_id, 1, 64);
    END IF;

    -- 5. ATOMIC WRITE 1: Insert initiating user Message
    INSERT INTO public.messages (
        id,
        thread_id,
        workspace_id,
        user_id,
        role,
        content,
        citations,
        created_at
    ) VALUES (
        v_message_id,
        p_thread_id,
        v_workspace_id,
        v_caller_id,
        'user',
        p_query,
        '[]'::jsonb,
        now()
    );

    -- 6. ATOMIC WRITE 2: Insert AgentRun in 'accepted' state
    INSERT INTO public.agent_runs (
        id,
        workspace_id,
        thread_id,
        initiating_message_id,
        assistant_message_id,
        user_id,
        correlation_id,
        query,
        status,
        verification_confidence_score,
        started_at,
        completed_at
    ) VALUES (
        v_run_id,
        v_workspace_id,
        p_thread_id,
        v_message_id,
        NULL,
        v_caller_id,
        v_correlation_id,
        p_query,
        'accepted',
        NULL,
        now(),
        NULL
    );

    RETURN QUERY
    SELECT 
        ar.id,
        ar.workspace_id,
        ar.thread_id,
        ar.initiating_message_id,
        ar.assistant_message_id,
        ar.user_id,
        ar.correlation_id,
        ar.query,
        ar.status,
        ar.verification_confidence_score,
        ar.started_at,
        ar.completed_at
    FROM public.agent_runs ar
    WHERE ar.id = v_run_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_agent_run_turn(UUID, TEXT, UUID, VARCHAR) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_agent_run_turn(UUID, TEXT, UUID, VARCHAR) TO authenticated;

-- ----------------------------------------------------------------------------
-- 2. Atomic Terminal Commitment: commit_agent_run_response
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.commit_agent_run_response(
    p_run_id UUID,
    p_status VARCHAR(30),
    p_assistant_content TEXT DEFAULT NULL,
    p_citations JSONB DEFAULT '[]'::jsonb,
    p_verification_score FLOAT DEFAULT NULL
)
RETURNS TABLE (
    id UUID,
    workspace_id UUID,
    thread_id UUID,
    initiating_message_id UUID,
    assistant_message_id UUID,
    user_id UUID,
    correlation_id VARCHAR(64),
    query TEXT,
    status VARCHAR(30),
    verification_confidence_score FLOAT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_caller_id UUID;
    v_run public.agent_runs%ROWTYPE;
    v_assistant_msg_id UUID := NULL;
BEGIN
    -- 1. Assert authenticated caller
    v_caller_id := auth.uid();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'UNAUTHENTICATED: Valid JWT session required'
            USING ERRCODE = '42501';
    END IF;

    -- 2. Validate terminal status
    IF p_status NOT IN ('completed', 'declined_uncertain', 'failed', 'cancelled') THEN
        RAISE EXCEPTION 'INVALID_PARAMETER: Target status must be a valid terminal status'
            USING ERRCODE = '22023';
    END IF;

    -- 3. Row lock target run with tenant membership verification
    SELECT ar.* INTO v_run
    FROM public.agent_runs ar
    JOIN public.workspace_members wm ON wm.workspace_id = ar.workspace_id
    WHERE ar.id = p_run_id
      AND wm.user_id = v_caller_id
    FOR UPDATE;

    IF v_run.id IS NULL THEN
        RAISE EXCEPTION 'FORBIDDEN_OR_NOT_FOUND: Run does not exist or caller lacks workspace membership'
            USING ERRCODE = '42501';
    END IF;

    -- 4. Check if already terminal (idempotency / concurrency safety)
    IF v_run.status IN ('completed', 'declined_uncertain', 'failed', 'cancelled') THEN
        RAISE EXCEPTION 'CONFLICT: Agent run is already in terminal state %', v_run.status
            USING ERRCODE = 'P0001';
    END IF;

    -- 5. Validate lifecycle transition: must be 'running' or 'accepted'
    IF v_run.status NOT IN ('running', 'accepted') THEN
        RAISE EXCEPTION 'INVALID_TRANSITION: Cannot transition from % to %', v_run.status, p_status
            USING ERRCODE = '22023';
    END IF;

    -- 6. Terminal Assistant Message Semantics
    IF p_status IN ('completed', 'declined_uncertain') THEN
        IF p_assistant_content IS NOT NULL AND trim(p_assistant_content) <> '' THEN
            v_assistant_msg_id := gen_random_uuid();
            INSERT INTO public.messages (
                id,
                thread_id,
                workspace_id,
                user_id,
                role,
                content,
                citations,
                created_at
            ) VALUES (
                v_assistant_msg_id,
                v_run.thread_id,
                v_run.workspace_id,
                NULL, -- Assistant messages have user_id = null
                'assistant',
                p_assistant_content,
                COALESCE(p_citations, '[]'::jsonb),
                now()
            );
        END IF;
    ELSE
        -- Hard rule: Failed or cancelled runs MUST NOT create assistant messages
        IF p_assistant_content IS NOT NULL AND trim(p_assistant_content) <> '' THEN
            RAISE EXCEPTION 'INVARIANT_VIOLATION: Assistant message cannot be committed on status %', p_status
                USING ERRCODE = '22023';
        END IF;
    END IF;

    -- 7. Update agent_runs row
    UPDATE public.agent_runs ar
    SET status = p_status,
        assistant_message_id = v_assistant_msg_id,
        verification_confidence_score = p_verification_score,
        completed_at = now()
    WHERE ar.id = p_run_id;

    RETURN QUERY
    SELECT 
        ar.id,
        ar.workspace_id,
        ar.thread_id,
        ar.initiating_message_id,
        ar.assistant_message_id,
        ar.user_id,
        ar.correlation_id,
        ar.query,
        ar.status,
        ar.verification_confidence_score,
        ar.started_at,
        ar.completed_at
    FROM public.agent_runs ar
    WHERE ar.id = p_run_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.commit_agent_run_response(UUID, VARCHAR, TEXT, JSONB, FLOAT) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.commit_agent_run_response(UUID, VARCHAR, TEXT, JSONB, FLOAT) TO authenticated;

-- ----------------------------------------------------------------------------
-- 3. Atomic State Transition: transition_agent_run_status
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transition_agent_run_status(
    p_run_id UUID,
    p_from_status VARCHAR(30),
    p_to_status VARCHAR(30)
)
RETURNS TABLE (
    id UUID,
    workspace_id UUID,
    thread_id UUID,
    initiating_message_id UUID,
    assistant_message_id UUID,
    user_id UUID,
    correlation_id VARCHAR(64),
    query TEXT,
    status VARCHAR(30),
    verification_confidence_score FLOAT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_caller_id UUID;
    v_run public.agent_runs%ROWTYPE;
BEGIN
    -- 1. Assert authenticated caller
    v_caller_id := auth.uid();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'UNAUTHENTICATED: Valid JWT session required'
            USING ERRCODE = '42501';
    END IF;

    -- 2. Validate valid transition
    IF p_from_status = 'accepted' AND p_to_status NOT IN ('running', 'failed', 'cancelled') THEN
        RAISE EXCEPTION 'INVALID_TRANSITION: Cannot transition from accepted to %', p_to_status
            USING ERRCODE = '22023';
    ELSIF p_from_status = 'running' AND p_to_status NOT IN ('completed', 'declined_uncertain', 'failed', 'cancelled') THEN
        RAISE EXCEPTION 'INVALID_TRANSITION: Cannot transition from running to %', p_to_status
            USING ERRCODE = '22023';
    ELSIF p_from_status IN ('completed', 'declined_uncertain', 'failed', 'cancelled') THEN
        RAISE EXCEPTION 'INVALID_TRANSITION: Cannot transition out of terminal state %', p_from_status
            USING ERRCODE = '22023';
    END IF;

    -- 3. Row lock target run with tenant membership verification
    SELECT ar.* INTO v_run
    FROM public.agent_runs ar
    JOIN public.workspace_members wm ON wm.workspace_id = ar.workspace_id
    WHERE ar.id = p_run_id
      AND wm.user_id = v_caller_id
    FOR UPDATE;

    IF v_run.id IS NULL THEN
        RAISE EXCEPTION 'FORBIDDEN_OR_NOT_FOUND: Run does not exist or caller lacks workspace membership'
            USING ERRCODE = '42501';
    END IF;

    IF v_run.status <> p_from_status THEN
        RAISE EXCEPTION 'CONFLICT: Expected run status % but current status is %', p_from_status, v_run.status
            USING ERRCODE = 'P0001';
    END IF;

    -- 4. Execute transition
    UPDATE public.agent_runs ar
    SET status = p_to_status,
        completed_at = CASE WHEN p_to_status IN ('completed', 'declined_uncertain', 'failed', 'cancelled') THEN now() ELSE ar.completed_at END
    WHERE ar.id = p_run_id;

    RETURN QUERY
    SELECT 
        ar.id,
        ar.workspace_id,
        ar.thread_id,
        ar.initiating_message_id,
        ar.assistant_message_id,
        ar.user_id,
        ar.correlation_id,
        ar.query,
        ar.status,
        ar.verification_confidence_score,
        ar.started_at,
        ar.completed_at
    FROM public.agent_runs ar
    WHERE ar.id = p_run_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.transition_agent_run_status(UUID, VARCHAR, VARCHAR) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.transition_agent_run_status(UUID, VARCHAR, VARCHAR) TO authenticated;

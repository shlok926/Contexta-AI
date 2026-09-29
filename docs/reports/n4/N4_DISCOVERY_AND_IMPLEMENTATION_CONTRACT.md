# N4 DISCOVERY AND IMPLEMENTATION CONTRACT
## Canonical Memory Engine & NestJS Memory Domain Module (`MemoryModule`)

- **Status:** DISCOVERY COMPLETE — IMPLEMENTATION AUTHORIZED
- **Phase ID:** N4 (Roadmap Phase 2 Trust Hardening / NestJS Migration Plan Phase N4)
- **Authors:** Staff AI Systems Architect, Application Security Reviewer
- **Date:** 2026-09-23
- **Governing ADRs:** `ADR-0004` (Canonical Memory Architecture & Tenancy), `ADR-0006` (NestJS Modular Monolith), `ADR-0008` (RBAC), `00_PROJECT_CONSTITUTION.md`

---

## 1. Current State Evidence & Reconstruction

### 1.1 Frozen Baselines
- **N3.8-C7.4** SSE Streaming Transport and Run Execution engine is verified and frozen (423 API tests, 274 Agent tests passing).
- Cross-cutting security layer (N2) is frozen (`JwtAuthGuard`, `WorkspaceMemberGuard`, `PermissionsGuard`, `RequestContext`).
- Database schema `memory_entries` and Row-Level Security (RLS) policies are active and frozen in `supabase/migrations/002_rls_policies_phase2.sql`.

### 1.2 Identified Migration Gap
- `apps/api/src/modules/memory/memory.module.ts` exists as an empty placeholder (`controllers: [], providers: []`).
- Legacy Express endpoints in `apps/api/src/routes/memory.ts` and `apps/api/src/services/memory.service.ts` execute physical SQL `DELETE` operations, violating the compliance and soft-delete mandate in `ADR-0004 §4.4`.
- Phase N4 is the sole remaining unmigrated functional domain before Legacy Express Retirement (Phase N5).

---

## 2. Objective & Scope

### 2.1 Primary Objective
Implement the canonical NestJS `MemoryModule` providing declarative, guarded, validated REST APIs for conversational and organizational memory management, fully aligned with ADR-0004 and `10_API_SPECIFICATION.md §7.9`.

### 2.2 In Scope
1. **REST Controller (`MemoryController`):**
   - `GET /v1/workspaces/:workspace_id/memory`: Paginated retrieval of memory entries for the authenticated user/workspace where `is_deleted = false`.
   - `DELETE /v1/workspaces/:workspace_id/memory/:memory_id`: Soft-deletion of a memory entry (`is_deleted = true`).
2. **Domain Service (`MemoryService`):**
   - Encapsulate server-authoritative workspace and user scoping using `RequestContext`.
   - Implement soft-delete mutations updating `is_deleted = true` and `updated_at = NOW()`.
   - Provide clean TypeScript interfaces for memory hydration and persistence.
3. **DTOs & Validation:**
   - Parameter and query validation pipes (`GetMemoriesQueryDto`, `MemoryResponseDto`).
4. **Defense-in-Depth Security:**
   - Enforce `@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, PermissionsGuard)`.
   - Enforce `@RequirePermissions('memory:read')` for `GET`.
   - Enforce `@RequirePermissions('memory:write_self')` / `@RequirePermissions('memory:write_shared')` for deletion.
5. **Comprehensive Test Suite:**
   - Unit tests, integration tests, RBAC tests, and adversarial tenancy verification.

### 2.3 Non-Scope (Forbidden Modifications)
- **NO** changes to frozen agent runtime services (`RunsOrchestratorService`, `AgentRuntimeService`, `AgentRunPersistenceService`).
- **NO** changes to LangGraph state definitions (`packages/agents/src/state.ts`) or graph topology (`packages/agents/src/graph.ts`).
- **NO** changes to database migrations or SQL schema.
- **NO** deletion of Express routes (strictly isolated to Phase N5).
- **NO** introduction of raw bearer tokens or client-supplied tenant identifiers into service methods.

---

## 3. Architectural Contracts

### 3.1 HTTP & API Contract
- **Base Route:** `/v1/workspaces/:workspace_id/memory`

#### Endpoint A: List Memory Entries
- **Method:** `GET`
- **Route:** `/v1/workspaces/:workspace_id/memory`
- **Headers:** `Authorization: Bearer <JWT>`
- **Query Params:** `limit?: number` (default 50, max 100), `offset?: number` (default 0)
- **Response Format:**
  ```json
  {
    "data": [
      {
        "id": "uuid",
        "workspace_id": "uuid",
        "user_id": "uuid",
        "fact": "string",
        "reason": "string",
        "source_agent": "string",
        "created_at": "ISO-8601 string"
      }
    ],
    "meta": {
      "total": 1,
      "limit": 50,
      "offset": 0
    }
  }
  ```

#### Endpoint B: Soft Delete Memory Entry
- **Method:** `DELETE`
- **Route:** `/v1/workspaces/:workspace_id/memory/:memory_id`
- **Headers:** `Authorization: Bearer <JWT>`
- **Response Format:**
  ```json
  {
    "data": {
      "success": true,
      "id": "uuid",
      "is_deleted": true
    }
  }
  ```

### 3.2 Runtime Execution Flow
```text
HTTP Client
    │
    ▼ [GET / DELETE]
JwtAuthGuard (Validates token -> Populates RequestContext.userId)
    │
    ▼
WorkspaceMemberGuard (Verifies membership in workspace_id -> Populates RequestContext.workspaceId & role)
    │
    ▼
PermissionsGuard (Verifies 'memory:read' or 'memory:write_self')
    │
    ▼
ValidationPipe (Validates UUID route params & query constraints)
    │
    ▼
MemoryController (Asserts URL workspace_id === RequestContext.workspaceId)
    │
    ▼
MemoryService (Executes query against PostgreSQL via Supabase client)
    ├── GET: WHERE workspace_id = :wsId AND user_id = :userId AND is_deleted = false
    └── DELETE: UPDATE memory_entries SET is_deleted = true WHERE id = :memId AND workspace_id = :wsId AND user_id = :userId
    │
    ▼
JSON Response Envelope
```

### 3.3 Persistence & RLS Model
- **Table:** `memory_entries`
- **RLS Policy:** `memory_workspace_isolation` active in PostgreSQL.
- **Logical Deletion Mandate:** Every deletion MUST be logical (`UPDATE ... SET is_deleted = true`). Physical SQL `DELETE` statements are strictly forbidden.

---

## 4. Risk Analysis

### 4.1 Critical Risk Classifications

#### P0 Risks (None Identified in Discovery)
- All schema and RLS requirements are already deployed and verified in Phase 2 migrations.

#### P1 Risks
1. **Cross-Tenant or Cross-User Memory Deletion (T8 Threat):**
   - *Risk:* A malicious user attempts to soft-delete another user's memory or a memory belonging to another workspace.
   - *Mitigation:* Service layer MUST explicitly enforce compound equality `WHERE id = :memoryId AND workspace_id = :workspaceId AND user_id = :userId`.
2. **URL Parameter Spoofing:**
   - *Risk:* Calling `/v1/workspaces/{workspace_B}/memory/{id}` with a token authenticated only for `workspace_A`.
   - *Mitigation:* `WorkspaceMemberGuard` validates membership in the route parameter workspace; `MemoryController` enforces strict equality between URL `:workspace_id` and `RequestContext.workspaceId`.

#### P2 Risks
1. **Idempotent Soft-Delete on Non-Existent or Already Deleted Entries:**
   - *Risk:* Calling `DELETE` on an ID that is already `is_deleted = true` returning ambiguous status.
   - *Mitigation:* Return `404 Not Found` if no row matching `(id, workspace_id, user_id, is_deleted = false)` was updated.
2. **Unbounded Result Size:**
   - *Risk:* `GET` query returning thousands of rows, exhausting node memory.
   - *Mitigation:* Enforce mandatory pagination DTO with a strict maximum limit of 100 rows.

---

## 5. Implementation Boundary

### 5.1 Allowed Files (Target Implementation Scope)
```text
apps/api/src/modules/memory/memory.module.ts
apps/api/src/modules/memory/controllers/memory.controller.ts
apps/api/src/modules/memory/services/memory.service.ts
apps/api/src/modules/memory/dto/get-memories-query.dto.ts
apps/api/src/modules/memory/dto/memory-response.dto.ts
apps/api/src/modules/memory/interfaces/memory.interface.ts
apps/api/__tests__/modules/memory/memory.controller.spec.ts
apps/api/__tests__/modules/memory/memory.service.spec.ts
apps/api/__tests__/modules/memory/memory-rbac.integration.spec.ts
```

### 5.2 Frozen Files (STRICTLY PROHIBITED FROM MODIFICATION)
```text
apps/api/src/modules/agents/controllers/runs.controller.ts
apps/api/src/modules/agents/services/runs-orchestrator.service.ts
apps/api/src/modules/agents/services/agent-runtime.service.ts
apps/api/src/modules/agents/services/agent-run-persistence.service.ts
packages/agents/src/graph.ts
packages/agents/src/state.ts
packages/agents/src/citation-verification/*
packages/agents/src/draft-response/*
packages/agents/src/research/*
packages/agents/src/supervisor/*
supabase/migrations/*
```

---

## 6. Implementation Sequence

1. **Step 1: Contracts & DTOs**
   - Create TypeScript interfaces and class-validator DTOs (`get-memories-query.dto.ts`, `memory-response.dto.ts`).
2. **Step 2: Domain Service Implementation**
   - Implement `MemoryService` with soft-delete mutations and server-authoritative context scoping.
3. **Step 3: Controller & Route Registration**
   - Implement `MemoryController` with `@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, PermissionsGuard)`.
   - Register controller and service in `MemoryModule`.
4. **Step 4: Unit & Integration Testing**
   - Write comprehensive test suites verifying pagination, soft delete, RBAC permission rejection, and tenant isolation.
5. **Step 5: Monorepo Verification & Audit**
   - Run typecheck, lint, unit tests, and regression tests across the monorepo.
   - Conduct independent freeze audit.

---

## 7. Definition of Done (DoD)

Phase N4 is complete ONLY when all following conditions are satisfied:
1. **Architectural Compliance:** `MemoryModule` is fully functional within NestJS without relying on legacy Express code.
2. **Soft-Delete Enforcement:** Deletions perform `is_deleted = true` updates without physical SQL row deletion.
3. **Security & Guard Conformance:** All endpoints enforce `JwtAuthGuard`, `WorkspaceMemberGuard`, and `PermissionsGuard` (`memory:read`, `memory:write_self`).
4. **Zero Regressions:** All 423 existing API tests and 274 Agent tests remain 100% green.
5. **Monorepo Hygiene:** `npm run typecheck`, `npm run lint`, and `npm run test` pass with 0 errors and 0 warnings.
6. **Frozen Boundaries Respected:** `git diff` confirms zero changes to frozen agent or database files.
7. **Freeze Audit:** An independent freeze audit report is generated and verified.

---

## 8. Final Authorization Gate

```text
================================================================================
DISCOVERY STATUS: COMPLETE
GATE VERDICT:     DISCOVERY COMPLETE — IMPLEMENTATION AUTHORIZED
NEXT STEP:        EXECUTE PHASE N4 IMPLEMENTATION PLAN
================================================================================
```

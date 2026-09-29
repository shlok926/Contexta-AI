# N5 DISCOVERY & DECOMMISSIONING CONTRACT
## Legacy Express Retirement & NestJS Final Cutover

- **Phase ID:** N5 (Legacy Express Retirement)
- **Status:** DISCOVERY COMPLETE — DECOMMISSIONING PLAN AUTHORIZED
- **Authors:** Staff AI Systems Architect, Application Security Reviewer, Legacy Decommissioning Architect
- **Date:** 2026-09-29
- **Governing Architecture:** `ADR-0001` (NestJS Modular Monolith), `ADR-0006` (NestJS Module Boundaries), `docs/implementation/PHASE-02_NESTJS_MIGRATION_IMPLEMENTATION_PLAN.md §17`, `00_PROJECT_CONSTITUTION.md`

---

## 1. Executive Summary

With the independent verification and freeze of **Phase N4 (Canonical Memory Module)**, all functional domain routes and services in Contexta-AI have been natively implemented in NestJS.

Phase N5 is dedicated to the **safe, surgical decommissioning of the legacy flat Express backend** (`apps/api/src/server.ts`, `routes/`, `controllers/`, `services/`, and `middleware/`). This discovery proves that no active component or script relies on the legacy Express entry point, and defines the exact decommissioning boundary.

---

## 2. Legacy Express Entrypoint & Startup Analysis

### 2.1 Process Entrypoint Comparison

```text
LEGACY EXPRESS (Obsolete / Unused)           CANONICAL NESTJS (Active Authority)
───────────────────────────────────           ───────────────────────────────────
File: apps/api/src/server.ts                  File: apps/api/src/main.ts
Bootstrap: express()                          Bootstrap: NestFactory.create(AppModule)
Port: process.env.PORT || 3001                Port: process.env.PORT || 3000
Scripts: NONE (Not referenced)                Scripts: package.json ("dev", "build", "start")
CORS: app.use(cors())                         CORS: app.enableCors(config-driven)
Middleware: Raw Express JSON                  Middleware: CorrelationIdMiddleware + Nest Guards
```

### 2.2 Execution Role Evidence
1. **Startup Authority:** `apps/api/package.json` executes `tsx watch src/main.ts` in `"dev"` and `node dist/main.js` in `"start"`. `server.ts` is never executed during normal development, testing, or production runtime.
2. **Import Analysis:** Grep analysis confirmed that `server.ts` is imported in **ZERO** files across the monorepo.
3. **Container & CI/CD Config:** `.github/workflows/ci.yml` and Docker targets invoke NestJS scripts (`yarn build`, `yarn start`).
4. **Frontend References:** Next.js frontend calls the standard backend port without depending on Express routes.

---

## 3. Capability Mapping & Decommissioning Matrix

Every capability in the legacy Express subsystem was evaluated against its canonical NestJS replacement:

| Legacy Component | Legacy Capability | Canonical NestJS Replacement | Status / Decommissioning Action |
| :--- | :--- | :--- | :--- |
| `apps/api/src/server.ts` | Express server bootstrap | `apps/api/src/main.ts` (`NestFactory.create(AppModule)`) | **DECOMMISSION (Delete)** |
| `apps/api/src/routes/health.ts` | `GET /v1/health` | `HealthModule` (needs `HealthController` registration) | **MIGRATE & DECOMMISSION** |
| `apps/api/src/routes/auth.ts` | `POST /login`, `POST /logout`, `/admin-only` | Supabase Auth handles auth; `JwtAuthGuard` handles verification. Prototype mocks are obsolete. | **DECOMMISSION (Delete)** |
| `apps/api/src/controllers/auth.controller.ts` | Mock auth controller | Supabase Client / `JwtAuthGuard` | **DECOMMISSION (Delete)** |
| `apps/api/src/services/auth.service.ts` | Mock auth service | Supabase Auth API | **DECOMMISSION (Delete)** |
| `apps/api/src/routes/workspaces.ts` | `POST /v1/workspaces` | `WorkspaceController` in `WorkspaceModule` | **DECOMMISSION (Delete)** |
| `apps/api/src/controllers/workspace.controller.ts` | Legacy workspace controller | `WorkspaceController` in `WorkspaceModule` | **DECOMMISSION (Delete)** |
| `apps/api/src/services/workspace.service.ts` | Legacy workspace service | `WorkspaceService` in `WorkspaceModule` | **DECOMMISSION (Delete)** |
| `apps/api/src/routes/runs.ts` | `POST /runs` | `RunsController` in `AgentRuntimeModule` | **DECOMMISSION (Delete)** |
| `apps/api/src/controllers/runs.controller.ts` | Legacy runs controller | `RunsController` in `AgentRuntimeModule` | **DECOMMISSION (Delete)** |
| `apps/api/src/services/runs.service.ts` | Legacy runs service | `RunsOrchestratorService` in `AgentRuntimeModule` | **DECOMMISSION (Delete)** |
| `apps/api/src/routes/memory.ts` | `GET`, `DELETE /memory` | `MemoryController` in `MemoryModule` | **DECOMMISSION (Delete)** |
| `apps/api/src/controllers/memory.controller.ts` | Legacy memory controller | `MemoryController` in `MemoryModule` | **DECOMMISSION (Delete)** |
| `apps/api/src/services/memory.service.ts` | Legacy memory service (hard delete) | Canonical `MemoryService` in `MemoryModule` (soft delete) | **DECOMMISSION (Delete)** |
| `apps/api/src/middleware/rbac.ts` | Raw Express RBAC middleware | `JwtAuthGuard`, `WorkspaceMemberGuard`, `PermissionsGuard` | **DECOMMISSION (Delete)** |

---

## 4. Decommissioning Scope & File Boundary

### 4.1 Target Files to Remove in Phase N5
```text
apps/api/src/server.ts
apps/api/src/routes/auth.ts
apps/api/src/routes/health.ts
apps/api/src/routes/memory.ts
apps/api/src/routes/runs.ts
apps/api/src/routes/workspaces.ts
apps/api/src/controllers/auth.controller.ts
apps/api/src/controllers/memory.controller.ts
apps/api/src/controllers/runs.controller.ts
apps/api/src/controllers/workspace.controller.ts
apps/api/src/services/auth.service.ts
apps/api/src/services/memory.service.ts
apps/api/src/services/runs.service.ts
apps/api/src/services/workspace.service.ts
apps/api/src/middleware/rbac.ts
```

### 4.2 Target Legacy Test Files to Clean Up in Phase N5
```text
apps/api/__tests__/memory/memory.api.test.ts
apps/api/__tests__/memory/persistence.test.ts
apps/api/__tests__/retrieval_graph/promptTemplate.test.ts
apps/api/__tests__/retrieval_graph/integration.test.ts
apps/api/__tests__/ingestion_graph/state.test.ts
apps/api/__tests__/rbac/rbac.test.ts
apps/api/__tests__/rbac/concurrency.test.ts
```

### 4.3 Target Additions / Migrations in Phase N5
- **Health Controller Registration:**
  - Create `apps/api/src/modules/health/controllers/health.controller.ts` (`GET /v1/health`)
  - Register `HealthController` in `apps/api/src/modules/health/health.module.ts`
  - Add unit test: `apps/api/__tests__/modules/health/health.controller.spec.ts`

### 4.4 Strictly Frozen Files (MUST REMAIN UNTOUCHED)
```text
apps/api/src/modules/agents/*
apps/api/src/modules/workspace/*
apps/api/src/modules/identity/*
apps/api/src/modules/memory/*
packages/agents/*
supabase/migrations/*
```

---

## 5. Risk Analysis & Mitigation

| Risk ID | Severity | Description | Mitigation Strategy |
| :--- | :---: | :--- | :--- |
| **RSK-N5-01** | **P1** | `GET /v1/health` becomes 404 if Express is removed before NestJS `HealthController` is registered. | Create and register `HealthController` in `HealthModule` before deleting `routes/health.ts`. |
| **RSK-N5-02** | **P2** | Stale test suites referencing deleted Express services cause `npm test` failures. | Clean up orphaned legacy mock tests (`__tests__/memory/memory.api.test.ts`) and ensure all active tests target NestJS modules. |
| **RSK-N5-03** | **P2** | Residual unused imports or empty folders in `apps/api/src/`. | Cleanly delete empty legacy directories (`routes/`, `controllers/`, `services/`, `middleware/`). |

---

## 6. Implementation Sequence for Phase N5

1. **Step 1:** Implement and test NestJS `HealthController` in `apps/api/src/modules/health/`.
2. **Step 2:** Delete flat legacy Express routes, controllers, services, middleware, and `server.ts`.
3. **Step 3:** Remove obsolete legacy tests referencing decommissioned Express services.
4. **Step 4:** Run static validation (`turbo typecheck`, `turbo lint`, `turbo build`).
5. **Step 5:** Run full API and Agent test suites (`yarn test:unit`, `yarn test`).
6. **Step 6:** Inspect git diff to verify zero impact on frozen modules.
7. **Step 7:** Compile `N5_IMPLEMENTATION_REPORT.md` and conduct independent freeze audit.

---

## 7. Definition of Done (DoD)

Phase N5 is complete ONLY when:
1. `apps/api/src/` contains zero flat `routes/`, `controllers/`, `services/`, `middleware/` directories, and no `server.ts`.
2. NestJS is the 100% sole authoritative backend server.
3. `GET /v1/health` responds with `200 OK` via NestJS `HealthController`.
4. Zero duplicate routes or shadowed endpoints exist across the application.
5. All 723+ monorepo tests pass with 0 errors and 0 skips.
6. Monorepo builds, typechecks, and lints with 0 warnings.
7. Independent freeze audit confirms zero regressions.

---

## 8. Final Authorization Gate

```text
================================================================================
DISCOVERY STATUS: COMPLETE
GATE VERDICT:     DISCOVERY COMPLETE — N5 DECOMMISSIONING AUTHORIZED
================================================================================
```

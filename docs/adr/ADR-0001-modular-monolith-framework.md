# ADR-0001 — Backend Framework for Contexta-AI Modular Monolith

## Status

Accepted

## Implementation Status

Not Yet Implemented (Scheduled for Phase 1 Foundation Milestone)

## Date

2026-09-12

## Decision Owners

Contexta-AI Architecture Group (Principal Software Architect)

---

## Context

A comprehensive documentation-suite review and repository audit identified an architectural misalignment between the system's foundational specifications and its current implementation:

1. **`00_PROJECT_CONSTITUTION.md §7.1`** mandates:  
   *"A modular Node.js framework (e.g., NestJS) is used to give the Modular Monolith (§4.1) explicit, enforceable module boundaries (controllers/services/modules per domain) — a deliberate choice over a flat Express app, since module-boundary discipline is otherwise easy to erode in plain Node."*
2. **`06_TECHNICAL_REQUIREMENTS.md §5`** and **`07_SYSTEM_ARCHITECTURE.md §6`** define the backend API service as a Node.js/TypeScript **Modular Monolith** featuring strict domain boundaries, dependency inversion, and internal module separation (API Gateway, Identity & Access, Ingestion, Agent Runtime, Retrieval, Memory, Analytics, and Event Bus).
3. **The Current Implementation in `apps/api`** consists of a rudimentary Express (`express: ^4.18.2`) application using procedural routers (`/routes`), direct module imports, lack of dependency injection, ad-hoc role checking in middleware (`/middleware/rbac.ts`), and unencapsulated service calls.

This divergence was formally logged as high-severity gap **GAP-P1-02** in `docs/DOCUMENTATION_SUITE_REVIEW_REPORT.md §9` and required resolution before freezing the documentation baseline.

---

## Problem

Contexta-AI requires an authoritative decision on its backend runtime framework:

- **Option A:** Adopt **NestJS** as the authoritative backend framework, providing framework-level runtime module encapsulation, native dependency injection, declarative guards, interceptors, and exception filters.
- **Option B:** Retain **Express** and engineer a disciplined Modular Monolith architecture around it using manual composition roots, TypeScript interfaces, factory functions, and automated import-boundary linter rules.

The framework must provide long-term architectural stability, enforce multi-tenant enterprise security, cleanly host the in-process LangGraph multi-agent execution graphs, support real-time Server-Sent Events (SSE) streaming, and preserve the future extraction path toward microservices if scale dictates.

---

## Scope & Architectural Deferrals

To maintain clear separation of concerns across the architecture baseline, **ADR-0001 is strictly bounded to the selection of the backend application framework**. 

Specific domain decisions and detailed subsystem specifications are explicitly deferred to subsequent ADRs and domain reconciliation freezes:

- **Vector Tenancy & Isolation Strategy:** Deferred to **ADR-0002**.
- **Citation Verification & Entailment Model:** Deferred to **ADR-0003**.
- **Frontend Static Export & API Gateway Topology:** Deferred to **ADR-0004**.
- **Authoritative RBAC Role Taxonomy:** Deferred to the Security Architecture (`11_SECURITY_ARCHITECTURE.md`) and Database Design (`09_DATABASE_DESIGN.md`) reconciliation freeze. *No new role names are introduced by this ADR.*
- **Database Table Ownership & Migrations:** Deferred to Database Design reconciliation.
- **Agent Execution Graph & Routing Classifier:** Deferred to AI Architecture (`08_AI_ARCHITECTURE.md`) reconciliation.

---

## Architectural Requirements

The framework selection must strictly fulfill the requirements documented across the Contexta-AI documentation baseline:

| Requirement ID | Requirement Name | Source Document | Section | Detailed Specification |
|---|---|---|---|---|
| **REQ-ARCH-01** | Modular Monolith Domain Boundaries | `00_PROJECT_CONSTITUTION.md`<br>`07_SYSTEM_ARCHITECTURE.md` | `00 §4.1`<br>`07 §6` | Explicit, bounded domain modules (Gateway, Auth, Ingestion, Agent Runtime, Retrieval, Memory, Analytics) preventing unintended cross-boundary coupling. |
| **REQ-ARCH-02** | Clean Architecture & Dependency Inversion | `00_PROJECT_CONSTITUTION.md` | `00 §4.3` | Dependencies point strictly inward. Domain core (agents, retrieval algorithms) must be decoupled from HTTP delivery and infrastructure SDKs. |
| **REQ-ARCH-03** | Future Service Extraction Path | `00_PROJECT_CONSTITUTION.md`<br>`15_ROADMAP.md` | `00 §4.2`<br>`15 §5` | Modules with distinct scaling profiles (Ingestion, Agent Runtime, Analytics) must be extractable into standalone services without rewrite. |
| **REQ-SEC-01** | Declarative Multi-Layer RBAC | `07_SYSTEM_ARCHITECTURE.md`<br>`11_SECURITY_ARCHITECTURE.md` | `07 §8.1`<br>`11 §6.4` | Gateway and controller-level role verification enforced declaratively before request execution, bound to the authoritative security baseline. |
| **REQ-SEC-02** | Strict Tenant & Workspace Isolation | `00_PROJECT_CONSTITUTION.md`<br>`11_SECURITY_ARCHITECTURE.md` | `00 §6.1`<br>`11 §5` | Mandatory `workspace_id` propagation, JWT claim validation, and defense-in-depth binding to Supabase Row-Level Security (RLS). |
| **REQ-SEC-03** | Boundary Input Validation | `00_PROJECT_CONSTITUTION.md`<br>`10_API_SPECIFICATION.md` | `00 §7.1`<br>`10 §12` | Schema-driven request payload validation at the controller boundary; fail-fast rejection of untyped or malformed inputs. |
| **REQ-AI-01** | In-Process LangGraph Agent Orchestration | `06_TECHNICAL_REQUIREMENTS.md`<br>`08_AI_ARCHITECTURE.md` | `06 TR-SYS-2`<br>`08 §6` | Agent execution graphs invoked as library services in-process, returning typed event streams without unnecessary network hops. |
| **REQ-AI-02** | Real-Time SSE Streaming | `07_SYSTEM_ARCHITECTURE.md`<br>`10_API_SPECIFICATION.md` | `07 §8.3`<br>`10 §7` | Streaming token updates, agent execution state transitions, and citations over Server-Sent Events with heartbeat and disconnect handling. |
| **REQ-OPS-01** | Unified Error Hierarchy & Exception Handling | `00_PROJECT_CONSTITUTION.md`<br>`10_API_SPECIFICATION.md` | `00 §7.1`<br>`10 §11` | Centralized error transformation mapping domain exceptions (`ContextaError`) to RFC 7807 problem details; zero uncaught crashes. |
| **REQ-OPS-02** | Structured Observability & Tracing | `00_PROJECT_CONSTITUTION.md`<br>`13_DEPLOYMENT.md` | `00 §7.5`<br>`13 §12` | Structured JSON logging (Pino), trace context propagation across agent nodes, health check endpoints, and graceful termination. |
| **REQ-TST-01** | Comprehensive Testability & Mocking | `00_PROJECT_CONSTITUTION.md`<br>`14_TESTING_STRATEGY.md` | `00 §12`<br>`14 §6–8` | High-fidelity unit and integration testing enabled by first-class dependency mocking for vector stores, LLM providers, and databases. |
| **REQ-DEP-01** | ECS Fargate Deployment Compatibility | `06_TECHNICAL_REQUIREMENTS.md`<br>`13_DEPLOYMENT.md` | `06 TR-INF-2`<br>`13 §5` | Stateless containerized execution behind Application Load Balancer with predictable memory consumption and lifecycle handling. |

---

## Considered Options

### Option A — NestJS (Enterprise Modular Framework)

NestJS is an opinionated, architecture-first Node.js framework designed for structured enterprise applications. It provides built-in architectural primitives based on TypeScript decorators, explicit module declarations (`@Module`), a hierarchical Dependency Injection (DI) container, declarative routing (`@Controller`), lifecycle management, and cross-cutting components (Guards, Interceptors, Pipes, Exception Filters).

- **Module System:** Every domain boundary is codified in a physical `@Module` class declaring explicit `imports`, `controllers`, `providers`, and `exports`. Services are encapsulated within their module at the DI runtime level unless explicitly exported.
- **Dependency Inversion:** Interfaces act as DI tokens; infrastructure adapters (Supabase client, Redis cache, LangGraph runtime) are injected into domain use-cases, satisfying Clean Architecture natively.
- **Cross-Cutting Pipeline:** Execution flows through a deterministic pipeline: Middleware &rarr; Guards (Auth & RBAC) &rarr; Interceptors (Tracing/Audit) &rarr; Pipes (Zod/Class-Validator validation) &rarr; Controller &rarr; Service &rarr; Exception Filter.
- **Streaming:** Native `@Sse()` decorator provides a structured abstraction over reactive streams (`Observable<MessageEvent>`), reducing HTTP streaming boilerplate while cleanly accommodating heartbeat, cancellation, timeout, and client disconnect handling.

### Option B — Express with Disciplined Modular Monolith Architecture

Express is a minimalist, unopinionated routing and middleware engine. Under Option B, Contexta-AI would retain Express and engineer a disciplined modular monolith architecture manually.

- **Module System:** Express can implement a modular monolith by organizing code into domain directories (`modules/<domain>/`) with standardized subfolders (`controllers/`, `services/`, `repositories/`, `dtos/`, `index.ts`). However, Express provides **no framework-level module encapsulation or boundary enforcement**. Preventing improper cross-module file imports relies entirely on developer discipline and automated tooling such as ESLint boundary rules (`eslint-plugin-import`) or `dependency-cruiser`.
- **Dependency Inversion:** Dependency inversion in Express can be achieved via manual composition roots (`container.ts` factory functions) and TypeScript interfaces, without strictly requiring a heavy third-party IoC container. However, wiring, lifetime management, and dependency passing must be manually maintained.
- **Cross-Cutting Pipeline:** Procedural middleware chaining on individual routers (`router.post('/runs', authenticate, requireRole(...), validateBody(schema), runController.create)`).
- **Streaming:** SSE connections managed manually via raw Node.js HTTP primitives (`res.writeHead(200, {...})`, manual formatting of `data: ...\n\n`, manual ping intervals, and explicit socket `close` listeners).

---

## Decision Matrix

Each option is evaluated against the architectural criteria on a 1–10 scale. Weights reflect Contexta-AI's identity as an enterprise-grade, multi-tenant intelligence platform.

| Criterion | Weight | Option A: NestJS Score | Option B: Express Score | Evaluation & Comparative Rationale |
|---|:---:|:---:|:---:|---|
| **1. Modular Monolith & Boundary Enforcement** | **15%** | **9** | **5** | **NestJS (9):** Built-in module system provides framework-level runtime DI encapsulation and standard packaging. Still requires lint/dependency-cruiser checks to prevent direct file imports across domains.<br>**Express (5):** Express has zero native concept of modules. Relies entirely on custom directory conventions and external linters to prevent architectural degradation. |
| **2. Clean Architecture & Dependency Inversion** | **10%** | **9** | **6** | **NestJS (9):** First-class hierarchical DI container standardizes interface-based dependency injection across all services.<br>**Express (6):** Fully capable of dependency inversion via manual factory composition roots, but requires maintaining bespoke wiring boilerplate across dozens of services. |
| **3. Security & Declarative RBAC** | **12%** | **9** | **6** | **NestJS (9):** Declarative `@UseGuards()` applied at controller or method level. Establishes a uniform guardrail that reduces human error.<br>**Express (6):** Procedural middleware must be manually chained to every route definition. Omitting a middleware function on a new route creates an immediate security gap. |
| **4. Testability & Dependency Mocking** | **10%** | **9** | **6** | **NestJS (9):** `@nestjs/testing` module builder enables isolated module testing and structured provider overrides (`overrideProvider().useValue(...)`).<br>**Express (6):** Readily testable via manual DI or Supertest, but integration test harnesses require manual assembly of mock dependency graphs. |
| **5. AI / LangGraph Integration & SSE Streaming** | **10%** | **9** | **7** | **NestJS (9):** `@Sse()` abstraction structures event streaming cleanly from reactive LangGraph streams while facilitating cancellation and heartbeat lifecycle management.<br>**Express (7):** Capable of streaming, but requires repetitive, low-level HTTP socket plumbing, manual header management, and custom disconnect handlers. |
| **6. Maintainability & Codebase Governance** | **12%** | **9** | **5** | **NestJS (9):** High degree of standardization. Structure, lifecycle, and component roles are familiar across the Node.js ecosystem, minimizing architectural drift.<br>**Express (5):** Because Express is unopinionated, the team must invent, document, and continuously police proprietary conventions for controllers, services, and routing. |
| **7. Developer Experience & Standardization** | **8%** | **8** | **8** | **NestJS (8):** Rich ecosystem, structured conventions, and CLI tooling, balanced against the decorator/metadata learning curve.<br>**Express (8):** Universal familiarity and initial simplicity, offset by the lack of structural guidance for large-scale enterprise backends. |
| **8. Enterprise Scalability & Service Extraction** | **8%** | **9** | **6** | **NestJS (9):** Bounded modules with explicit inputs and outputs map cleanly to independent microservices or worker containers using NestJS microservice transports.<br>**Express (6):** Service extraction requires manually untangling shared procedural middleware, router composition roots, and implicit request extensions. |
| **9. Observability & Centralized Error Handling** | **5%** | **9** | **6** | **NestJS (9):** Native Exception Filters map domain exceptions (`ContextaError`) to RFC 7807 problem details globally; Interceptors provide structured request/response telemetry.<br>**Express (6):** Error handling via 4-argument middleware `(err, req, res, next)` works, but unhandled async promise rejections and missing `next(err)` calls remain common failure modes. |
| **10. Deployment & Runtime Overhead** | **5%** | **8** | **9** | **NestJS (8):** Minor memory footprint (~15–25MB overhead for IoC container and metadata reflection), negligible in persistent AWS ECS Fargate tasks.<br>**Express (9):** Extremely lightweight footprint and near-instantaneous process startup. |
| **11. Current Codebase Compatibility & Migration Cost** | **5%** | **5** | **9** | **NestJS (5):** Requires refactoring existing Express routes, middleware, and controllers into NestJS modules.<br>**Express (9):** Directly preserves the existing files in `apps/api/src/`. |
| **Weighted Total** | **100%** | **8.78 / 10** | **6.22 / 10** | **NestJS provides a decisively superior architectural foundation (+41.2% overall score).** |

---

## Decision

**Contexta-AI adopts OPTION A: NestJS as the authoritative backend framework for the Modular Monolith.**

The current Express skeleton in `apps/api` will be refactored into a structured NestJS application using `@nestjs/platform-express`. The backend will strictly implement the bounded modular monolith topology mandated by `00_PROJECT_CONSTITUTION.md §4.1` and `07_SYSTEM_ARCHITECTURE.md §6`.

---

## Rationale

1. **Constitutional Alignment:** `00_PROJECT_CONSTITUTION.md §7.1` explicitly selected a modular framework to prevent the boundary erosion common in plain Node.js applications. Ratifying Express would contradict the constitutional principle of establishing enforceable architectural boundaries.
2. **Current Codebase State Minimizes Migration Blast Radius:** An inspection of `apps/api` reveals that the existing Express backend contains fewer than 500 lines of application code across four simple routes (`auth.ts`, `health.ts`, `memory.ts`, `runs.ts`) and three basic services. There is no large legacy codebase to preserve; adopting NestJS now incurs minimal cost, whereas doing so after building complex enterprise features would require an extensive rewrite.
3. **Architectural Primitives Out of the Box:** While Express *can* support a modular monolith through manual composition roots and strict discipline, it provides few architectural primitives out of the box. NestJS provides standardized modules, dependency injection, guards, interceptors, and exception filters natively, freeing the team from building and maintaining a proprietary in-house framework on top of Express.
4. **Declarative Security Guardrails:** Enterprise multi-tenancy demands zero-trust security. In Express, forgetting to attach an authentication or RBAC middleware to a single route creates an immediate cross-tenant vulnerability. In NestJS, declarative guards (`@UseGuards()`) applied at the controller class level ensure uniform protection by default.
5. **Clean Architecture & LangGraph Inversion:** Contexta-AI's core intelligence layer resides in `packages/agents` (LangGraph multi-agent execution) and `packages/retrieval`. NestJS's hierarchical DI container standardizes the injection of domain abstractions and infrastructure adapters, facilitating isolated unit testing without global monkey-patching.
6. **Future Service Extraction Path:** High-throughput domains (Ingestion, Agent Runtime, Analytics) are designated for potential future extraction into standalone microservices or worker containers (`00 §4.2`, `15 §5`). NestJS modules decouple transport layers from business logic, making future service extraction straightforward.

---

## Consequences

### Positive Consequences
- **Rigid Architectural Governance:** The NestJS module system provides framework-level runtime DI encapsulation, giving the modular monolith a clear, standard structure.
- **Enterprise-Grade Security Pipeline:** Declarative guards guarantee uniform authentication, role enforcement, and tenant workspace scoping across endpoints.
- **Structured Streaming:** The `@Sse()` abstraction structures event streaming cleanly from reactive LangGraph streams while facilitating cancellation and heartbeat lifecycle management.
- **First-Class Testability:** Unit, integration, and E2E testing utilize `@nestjs/testing` to mock external dependencies (Supabase, OpenAI, Redis) without brittle global mocking.
- **Documentation Alignment:** Reconciles the documented target architecture across `00`, `06`, `07`, `10`, `11`, `13`, and `14`, resolving GAP-P1-02.

### Negative Consequences
- **Framework Abstraction Overhead:** Introduces decorators, metadata reflection (`reflect-metadata`), and IoC container concepts that developers must adhere to.
- **TypeScript Compiler Configuration:** Requires `experimentalDecorators: true` and `emitDecoratorMetadata: true` in `apps/api/tsconfig.json`.

### Trade-offs
- The team accepts the syntactic overhead of NestJS classes and decorators in exchange for automated dependency injection, declarative security, and standard architectural primitives.

---

## Required Architectural Rules

To ensure NestJS delivers a true Modular Monolith rather than an unmaintainable monolith, the following rules are mandatory:

### 1. Illustrative Bounded Module Topology
Domain code will be organized into encapsulated modules under `apps/api/src/modules/` (target layout subject to domain reconciliation):
```
apps/api/src/
├── app.module.ts
├── main.ts
├── common/
│   ├── decorators/
│   ├── filters/
│   ├── guards/
│   ├── interceptors/
│   └── pipes/
└── modules/
    ├── identity/           # Identity & Access (Auth, Users)
    ├── workspaces/         # Workspace Tenancy Management
    ├── ingestion/          # Document upload, chunking, staging
    ├── agents/             # LangGraph Supervisor & Agent Runtime
    ├── retrieval/          # Hybrid search & Reranking integration
    ├── memory/             # Persistent & Short-Term Memory
    └── analytics/          # Run telemetry, traces, audit logs
```

### 2. Module Boundary Enforcement
- **DI Encapsulation:** Controllers, services, and repositories are private to their module by default. Only services explicitly listed in the `@Module({ exports: [...] })` array may be injected into other modules.
- **Automated Dependency Boundary Checks:** Because TypeScript does not prevent direct relative imports across directories at compile time, automated architectural linting (via `eslint-plugin-import` boundary rules or `dependency-cruiser`) must be integrated into CI to prohibit cross-module direct file imports.
- **Zero Circular Dependencies:** Modules must not import each other cyclically. Cross-domain coordination must occur via shared packages (`packages/shared`), domain events, or mediator services.
- **No Cross-Domain Database Access:** No module may directly access database entities or tables owned by another domain.

### 3. Clean Architecture & Thin Controllers
- Controllers are strictly responsible for HTTP parsing, status codes, and delegating to domain services. **Controllers must never execute business logic, call LLMs directly, or execute raw database queries.**
- Business logic resides entirely within injectable services or specialized workspace packages (`packages/agents`, `packages/retrieval`).

### 4. Authoritative Security Guardrails
- Controller routes requiring authentication and authorization must be protected via NestJS `CanActivate` Guards.
- **Guards will enforce the authoritative RBAC vocabulary defined by the reconciled Security Architecture and Database Design baseline. No new role names are introduced by this ADR.**

### 5. Unified Error Translation
- Internal exceptions must inherit from `ContextaError` (defined in `packages/shared`).
- A global `ContextaExceptionFilter` must intercept all exceptions and format them into standard RFC 7807 Problem Details JSON. Raw database errors or stack traces must never leak to clients.

---

## Migration & Adoption Strategy

Refactoring `apps/api` will take place in a phased sequence during the upcoming backend implementation milestone:

1. **Phase 1: NestJS Foundation Setup**
   - Install NestJS core packages in `apps/api/package.json` (`@nestjs/core`, `@nestjs/common`, `@nestjs/platform-express`, `reflect-metadata`, `rxjs`).
   - Update `apps/api/tsconfig.json` to enable decorator metadata.
   - Establish `AppModule`, `main.ts`, global logging, and global `ContextaExceptionFilter`.
2. **Phase 2: Core Domain Migration**
   - Migrate `healthRouter` &rarr; `HealthController` in `HealthModule`.
   - Migrate `authRouter` &rarr; `AuthController` and `AuthService` in `IdentityModule` with Supabase Auth JWT validation.
   - Migrate `memoryRouter` &rarr; `MemoryController` in `MemoryModule`, injecting `MemoryService` backed by `packages/memory`.
   - Migrate `runsRouter` &rarr; `RunsController` in `AgentRuntimeModule`, integrating LangGraph invocation and `@Sse()` streaming.
3. **Phase 3: Cross-Cutting Hardening**
   - Implement authentication and RBAC guards bound to the reconciled security specification.
   - Implement Zod validation pipe for request DTOs.
   - Integrate dependency-cruiser boundary checks into the CI pipeline.
   - Verify that all unit, integration, and E2E tests pass cleanly.

---

## Impact on Existing Documentation

Following the ratification of this ADR, the documentation suite will be updated during the baseline freeze:

| Document | Required Reconciliation Update |
|---|---|
| **`00_PROJECT_CONSTITUTION.md`** | Update §7.1 and §7.6 to remove provisional language ("NestJS or equivalent") and ratify NestJS as the confirmed backend framework. |
| **`06_TECHNICAL_REQUIREMENTS.md`** | Update Technology Stack Requirements Table (§5) to confirm NestJS. |
| **`07_SYSTEM_ARCHITECTURE.md`** | Update API Gateway and Component Breakdown (§6, §7) to reflect concrete NestJS module wiring, providers, and exception filter topology. |
| **`10_API_SPECIFICATION.md`** | Align route controller conventions and `@Sse()` streaming contracts in §7 and §12. |
| **`13_DEPLOYMENT.md`** | Update container build instructions in §8 to specify NestJS production bundle compilation. |
| **`15_ROADMAP.md`** | Schedule the NestJS modular monolith refactoring under Phase 1. |
| **`README.md`** | Update Technology Stack summary table to list NestJS for Backend API. |
| **`DOCUMENTATION_SUITE_REVIEW_REPORT.md`** | Update Gap Analysis §9 to mark **GAP-P1-02** and **REG-08** as formally resolved by ADR-0001. |

---

## Impact on Existing Code

The following code areas in the repository are affected and scheduled for refactoring during the implementation milestone:
- `apps/api/package.json`: Replace direct application-level Express usage with NestJS and `@nestjs/platform-express`; retain Express only as an underlying HTTP adapter dependency where required.
- `apps/api/tsconfig.json`: Enable `experimentalDecorators` and `emitDecoratorMetadata`.
- `apps/api/src/server.ts`: Replace with standard NestJS `main.ts` bootstrap entrypoint.
- `apps/api/src/routes/*`: Transition flat procedural routers into NestJS controllers inside their respective domain modules.
- `apps/api/src/middleware/rbac.ts`: Replace procedural middleware with reusable NestJS `CanActivate` Guards.
- `apps/api/src/services/*`: Decorate service classes with `@Injectable()` and register them within domain modules.
- `apps/api/__tests__/*`: Update test harnesses from ad-hoc Express instances to `Test.createTestingModule()`.

*Note: Application code will not be modified within this decision task. Implementation will proceed under a dedicated engineering milestone.*

---

## Alternatives Rejected

### Rejection of Option B: Express with Bespoke Modular Discipline
Option B was rejected for the following reasons:
1. **High Maintenance Overhead of In-House Architecture:** Building dependency injection, module encapsulation conventions, declarative guard pipelines, and validation wrappers on top of Express requires writing and maintaining a custom, proprietary framework inside Contexta-AI.
2. **Vulnerability to Human Error in Security Enforcement:** Procedural route chaining in Express relies on developers remembering to manually attach authentication and RBAC middleware to every newly created route. Missing a single middleware in an enterprise multi-tenant platform creates an immediate security gap.
3. **Lack of Standard Primitives:** Express provides no native concept of modules, dependency injection, or lifecycle hooks. NestJS provides these primitives natively, establishing an architectural standard that prevents codebase erosion as the platform expands.

---

## Risks and Mitigations

| Identified Risk | Severity | Mitigation Strategy |
|---|:---:|---|
| **Learning Curve for Developers** | Medium | Establish standard module template recipes and comprehensive code generator conventions; provide reference implementation in `IdentityModule`. |
| **Runtime Overhead** | Low | NestJS overhead is negligible (~20MB RAM, <1s startup); containerized execution on AWS ECS Fargate runs as a persistent daemon where warm startup latency is not a factor. |
| **LangGraph.js Integration Friction** | Low | LangGraph execution graphs are already modular TypeScript libraries under `packages/agents/`. They will be injected into NestJS services cleanly via standard constructor injection. |

---

## Validation Plan

The implementation of this ADR will be validated against the following concrete criteria during the backend refactoring milestone:

1. **Quality Gates Verification:** `apps/api` must achieve zero lint errors (`yarn lint`), zero typecheck errors with `strict: true` (`yarn typecheck`), and pass all unit/integration tests (`yarn test`).
2. **Module Encapsulation Check:** Automated dependency-cruiser checks in CI to ensure no private services or repositories are imported across module boundaries.
3. **Security Gate Enforcement:** Integration test suite validating that any request lacking a valid JWT or lacking the required workspace role returns an immediate `401 Unauthorized` or `403 Forbidden` response generated by NestJS Guards.
4. **SSE Streaming Validation:** Test suite confirming that run endpoints stream valid SSE tokens, step traces, and citations using NestJS `@Sse()` with client disconnect handling.

---

## Related Decisions

This decision establishes the foundational architectural substrate for the platform. Subsequent Architecture Decision Records will build directly upon this foundation:

- **ADR-0002 — Vector Tenancy Isolation Strategy:** Defining database-level vs. application-level workspace isolation within `RetrievalModule`.
- **ADR-0003 — Citation Entailment Model & Threshold Verification:** Defining deterministic vs. NLI-based claim verification within `AgentRuntimeModule`.
- **ADR-0004 — Next.js Static Export & API Gateway Topology:** Ratifying CloudFront + S3 static frontend deployment communicating with the NestJS API Gateway on ECS Fargate.

---

## Decision Outcome

**ADR-0001 is formally ACCEPTED.** Contexta-AI will standardize on **NestJS** as its backend modular framework. All future backend development and documentation reconciliation will proceed under this authoritative architectural baseline.

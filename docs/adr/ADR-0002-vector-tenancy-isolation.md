# ADR-0002 — Vector Tenancy Isolation Strategy

## Status

Accepted

## Implementation Status

Not Yet Implemented (Scheduled for Phase 1 Database & Retrieval Milestone)

## Date

2026-09-12

## Decision Owners

Contexta-AI Architecture Group (Principal Software Architect, Security Architect, Database Engineer)

---

## Context

A critical architectural contradiction was identified between Contexta-AI's core security specifications and its database design, formally recorded as **GAP-P0-01** in `docs/DOCUMENTATION_SUITE_REVIEW_REPORT.md §9`:

1. **`11_SECURITY_ARCHITECTURE.md §7.1 & §7.2`** mandates:
   - *"Every embedding write carries a `workspace_id` partition key."*
   - *"Similarity search queries are **always** pre-filtered by `workspace_id` before the ANN search executes, not post-filtered on results (post-filtering would leak the existence/ranking of cross-tenant content even if content is redacted)."*
   - Postgres Row-Level Security (RLS) policies must strictly isolate vector queries at the database layer.
2. **`09_DATABASE_DESIGN.md §6.8 & §8`** defines a normalized 4-tier schema where `embeddings` and `chunks` do **not** possess a `workspace_id` column:
   - `embeddings` table contains only `(id, chunk_id, embedding_vector, model_name, created_at)`.
   - `chunks` table contains only `(id, document_version_id, chunk_offset, content, token_count)`.
   - Workspace tenancy is deferred to relational query joins:  
     `embeddings` &rarr; `chunks` &rarr; `document_versions` &rarr; `documents.workspace_id`.
3. **Current Repository Code in `packages/retrieval/src/index.ts`** uses the legacy single-table schema inherited from the base repository (`mayooear/ai-pdf-chatbot-langchain`):
   - Targets a legacy flat table `documents` via `match_documents`.
   - Contains no `workspace_id` column or tenant scoping in the database query.
   - `supabase/migrations/001_rls_policies.sql` executed `ALTER TABLE embeddings ENABLE ROW LEVEL SECURITY;` but defined **no RLS policy** for `embeddings`, resulting in zero queryable rows under standard non-superuser RLS roles.

This contradiction directly impacts Contexta-AI's primary enterprise requirement: **ironclad multi-tenant data isolation and zero cross-tenant knowledge leakage**.

---

## Problem

Contexta-AI must resolve how vector embeddings and chunks are scoped to workspaces across the physical schema, the Postgres Row-Level Security (RLS) layer, the `pgvector` Approximate Nearest Neighbor (ANN) index traversal, and application retrieval logic.

The architectural decision must address:
- **Tenant Isolation Guarantee:** How to guarantee that a tenant query cannot observe, rank, or infer another tenant's vector data, establishing that caller-supplied workspace IDs are never treated as authorization credentials.
- **Security Context in Database Functions:** How database vector-search functions must establish caller authorization, avoiding privilege-escalation vulnerabilities inherent in unvalidated `SECURITY DEFINER` functions.
- **ANN Filtering Separation:** Distinguishing the non-negotiable security requirement (restricting retrieval to tenant artifacts at the database boundary) from the physical execution optimization (HNSW iterative scanning).
- **Relational vs. Denormalized Tenancy:** Resolving the latency penalty of multi-table joins during vector similarity search without compromising data integrity.
- **Consistency of Denormalized Keys:** Ensuring that duplicating `workspace_id` across documents, chunks, and embeddings cannot result in silent metadata divergence.

---

## Non-Negotiable Security Invariant

Every component of the Contexta-AI architecture must strictly enforce the following invariant:

> ### Security Invariant: Strict Vector Tenancy Isolation
> **A retrieval operation initiated within the security context of Workspace $A$ ($\text{Wks}_A$) must NEVER return, rank, observe, evaluate, or infer any embedding, chunk, document metadata, or derived semantic context belonging to Workspace $B$ ($\text{Wks}_B$), under any condition, concurrency level, or query failure state.**
>
> $$\forall q \in \text{Queries}(\text{Wks}_A), \quad \text{Results}(q) \subseteq \text{Artifacts}(\text{Wks}_A) \quad \land \quad \text{Results}(q) \cap \text{Artifacts}(\text{Wks}_B) = \emptyset$$

### The Authorization Principle: Filter IDs Are Not Credentials
A caller-supplied `workspace_id` (whether passed via URL, request body, or RPC parameter) is **strictly a query scoping parameter, NEVER an authorization credential**. The database engine and application must independently verify that the authenticated caller identity (`auth.uid()`) holds active, valid membership in the requested workspace before evaluating any retrieval operation.

---

## Security vs. Performance: Disentangling Tenancy Architecture

To ensure enterprise rigor, Contexta-AI explicitly decouples **security guarantees** from **performance optimizations**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           1. SECURITY BOUNDARY                              │
│  Verified JWT Identity (auth.uid())                                         │
│       ↓                                                                     │
│  Caller Membership Verification (workspace_members WHERE user_id=auth.uid()) │
│       ↓                                                                     │
│  Postgres Row-Level Security (RLS) + SECURITY INVOKER Context               │
│       ↓                                                                     │
│  Zero Cross-Tenant Leakage Guarantee (Invariant Holds Regardless of Index)  │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         2. PERFORMANCE OPTIMIZATION                         │
│  Denormalized workspace_id on chunks & embeddings (Eliminates 3-table join) │
│       ↓                                                                     │
│  B-tree Indexes on workspace_id (Fast scalar pre-filtering)                 │
│       ↓                                                                     │
│  pgvector HNSW Iterative Index Scan (ef_search tuning for tenant partition) │
│       ↓                                                                     │
│  Sub-second SLA Achievement (Operational Target: p95 < 300ms)               │
└─────────────────────────────────────────────────────────────────────────────┘
```

1. **The Security Guarantee:** Security is enforced by identity verification, membership authorization, and database Row-Level Security. Even if the vector index were dropped, corrupted, or forced into a sequential table scan, **cross-tenant data access remains structurally impossible**.
2. **The Performance Optimization:** Denormalizing `workspace_id` onto `chunks` and `embeddings` enables the database query planner to apply scalar tenant filters without executing expensive multi-table joins on every vector graph candidate.
3. **Filtering Timing, Index Traversal, and pgvector 0.8.0+ Mechanics:**
   - **Application Post-Filtering (Strictly Prohibited):** Selecting top-$K$ nearest neighbors globally across all tenants and filtering by tenant in application memory (or after global index selection) causes severe recall collapse (if tenant vectors are not in the global top-$K$) and leaks existence/timing information.
   - **Database-Enforced Tenant Filtering (Mandatory Security Boundary):** Tenant filtering must constrain the candidate pool **at the database retrieval boundary**. The database must only return rows belonging to the authorized workspace.
   - **pgvector Index Traversal Mechanics (0.8.0+):** In `pgvector` 0.8.0+, iterative index scans were introduced for approximate vector indexes (both HNSW and IVFFlat). In `pgvector`, with approximate indexes, filtering is applied after the index scan, and iterative scans dynamically increase the proportion of the index scanned when necessary until sufficient qualifying rows meeting the filter predicate and threshold are found. This is an execution optimization rather than a mathematically guaranteed "pre-filtering inside graph traversal"; actual execution and index scan behavior must be validated using `EXPLAIN (ANALYZE, BUFFERS)` in CI.
   - **Multitenancy Scaling & Partitioning Consideration:** Current `pgvector` documentation explicitly notes that with approximate indexes, filtering occurs after candidate scanning and recommends considering table or index partitioning for large multitenant workloads where numerous distinct tenant values exist (because vectors belonging to other tenants in a shared approximate index can affect recall and traversal speed). Contexta-AI adopts a single shared table with denormalized `workspace_id` and B-tree indexing as the baseline architecture, and classifies declarative table partitioning by `workspace_id` as a scale-triggered alternative to be evaluated and benchmarked if cross-tenant interference degrades recall under high workspace counts.

---

## Considered Options

### Option A — Direct Workspace-Scoped Embeddings (Denormalization Only)
Add `workspace_id` directly to `embeddings` and `chunks`. Queries filter on `WHERE embeddings.workspace_id = $1`. Relational foreign keys are retained for basic cascade deletion, but tenancy enforcement is treated primarily as a single-column query parameter.
- *Pros:* Eliminates multi-table joins during similarity search.
- *Cons:* Treats tenancy as a query optimization rather than a multi-layered security boundary; lacks mandatory integrity constraints to prevent denormalization drift; omits application-layer post-fetch assertions and cache-key namespacing.

### Option B — Relational Workspace Scoping Through Joins
Preserve strict third normal form (3NF) as documented in `09_DATABASE_DESIGN.md §6.8`. `embeddings` stores only `chunk_id`. All workspace isolation is resolved dynamically via SQL joins (`chunks` &rarr; `document_versions` &rarr; `documents`).
- *Pros:* Strict relational normalization; single source of truth for workspace assignment on `documents`.
- *Cons:* Extremely poor retrieval performance; RLS subqueries require evaluating a 4-table join on every vector candidate row during HNSW graph traversal; severe query planner degradation and time-outs at scale; vulnerable to recall collapse under pgvector index scans.

### Option C — Hybrid Defense-In-Depth Architecture (Authoritative Decision)
A synchronized, 4-tier isolation architecture combining physical denormalization, database-enforced authorization, pre-filtered indexing, and application-layer assertion:
1. **Physical Storage Tier:** Denormalize `workspace_id UUID NOT NULL` onto both `embeddings` and `chunks`, backed by composite B-tree indexes, foreign-key cascade constraints, and **mandatory database consistency triggers** preventing tenant ID divergence.
2. **Database Engine Tier (RLS & Security Context):** Supabase/Postgres RLS enabled on `embeddings`, `chunks`, `document_versions`, and `documents`. Vector search functions execute under **`SECURITY INVOKER`** context, ensuring RLS remains active, supplemented by an explicit caller-membership authorization check.
3. **Index & Execution Tier:** `pgvector` (0.8.0+) HNSW index with iterative scan filtering bounded by `embeddings.workspace_id = $1`; B-tree and GIN indexes on `chunks` filtered by `chunks.workspace_id = $1`.
4. **Application & Gateway Tier:** The NestJS `RetrievalModule` resolves `workspace_id` from cryptographically verified JWT claims, enforces parameter binding, executes post-fetch boundary assertions, and namespaces all Redis embedding/query caches (`ctx:wks:<workspace_id>:*`).

---

## Decision Matrix

| Criterion | Weight | Option A: Direct Denormalization | Option B: Relational Joins | Option C: Hybrid Defense-in-Depth | Comparative Evaluation |
|---|:---:|:---:|:---:|:---:|---|
| **1. Tenant Isolation & Security Guarantee** | **20%** | **7** | **6** | **10** | **Hybrid (10):** 4 independent barriers (JWT &rarr; SQL parameter &rarr; Postgres RLS/Invoker check &rarr; post-fetch assertion). If any single layer fails, isolation holds.<br>**Relational (6):** Relies on complex RLS join subqueries prone to planner bypass or misconfiguration.<br>**Direct (7):** Lacks multi-tier verification. |
| **2. Vector ANN Search Performance & Latency** | **15%** | **9** | **2** | **9** | **Hybrid (9) & Direct (9):** Single-column scalar pre-filter allows fast HNSW graph traversal without per-vector joins.<br>**Relational (2):** 3-table join on candidate graph nodes during index scan causes severe I/O and CPU thrashing. |
| **3. ANN Recall & Precision (No Over-Filtering)** | **15%** | **9** | **3** | **9** | **Hybrid (9):** Pre-filtering during HNSW scan guarantees all top-$K$ candidates belong to the requesting tenant.<br>**Relational (3):** High risk of candidate starvation when traversing across multi-tenant graphs without fast scalar pre-filters. |
| **4. RLS Policy Efficiency & Scalability** | **10%** | **7** | **3** | **10** | **Hybrid (10):** Single-column workspace predicate with indexed membership resolution avoids per-vector multi-table joins.<br>**Relational (3):** Evaluates multi-table subqueries per row, scaling poorly on large datasets. |
| **5. Data Integrity & Consistency Enforcement** | **10%** | **6** | **10** | **9** | **Relational (10):** 3NF normalization guarantees single source of truth.<br>**Hybrid (9):** Denormalizes `workspace_id` but enforces mandatory database triggers guaranteeing document/chunk/embedding consistency.<br>**Direct (6):** Unprotected denormalization risks metadata divergence. |
| **6. Cache & Memory Isolation** | **10%** | **5** | **4** | **10** | **Hybrid (10):** Explicitly defines workspace-namespaced cache keys in Redis (`ctx:wks:<workspace_id>:*`), preventing cross-tenant cache pollution.<br>**Direct/Relational (4-5):** Caching boundaries unaddressed. |
| **7. Testability & Auditability** | **10%** | **7** | **5** | **10** | **Hybrid (10):** Fully verifiable via automated CI cross-tenant adversarial suites (forged IDs, direct RPC calls, RLS bypass attempts). |
| **8. Migration & Implementation Simplicity** | **10%** | **8** | **5** | **8** | **Hybrid (8) & Direct (8):** Repository currently uses a single table; migrating to hybrid requires updating migrations before production data accumulates. |
| **Weighted Total** | **100%** | **7.45 / 10** | **4.55 / 10** | **9.40 / 10** | **Option C (Hybrid Defense-in-Depth) is the decisively superior architectural choice (+106% over Relational).** |

---

## Decision

**Contexta-AI adopts OPTION C: ADOPT HYBRID DEFENSE-IN-DEPTH as the authoritative Vector Tenancy Isolation Strategy.**

The database schema, indexing strategy, RLS policies, retrieval engine, and cache hierarchy will implement a synchronized 4-tier tenant isolation boundary. The schema in `09_DATABASE_DESIGN.md` will be reconciled to store `workspace_id UUID NOT NULL` directly on both `chunks` and `embeddings`, backed by mandatory consistency triggers and foreign-key relationships.

---

## Authoritative Data Model & Mandatory Consistency

### 1. Physical Schema
```sql
-- 1. documents (Tenant Root for Knowledge)
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    uploaded_by UUID NOT NULL REFERENCES users(id),
    title VARCHAR(500) NOT NULL,
    source_type VARCHAR(30) NOT NULL,
    s3_object_key VARCHAR(1024) NOT NULL,
    current_version_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. document_versions (Immutable Version Records)
CREATE TABLE document_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version_number INT NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'pending',
    is_superseded BOOLEAN NOT NULL DEFAULT false,
    ingested_at TIMESTAMPTZ,
    CONSTRAINT uq_document_version UNIQUE (document_id, version_number)
);

ALTER TABLE documents 
    ADD CONSTRAINT fk_documents_current_version 
    FOREIGN KEY (current_version_id) REFERENCES document_versions(id) ON DELETE SET NULL;

-- 3. chunks (Denormalized workspace_id for Fast Hybrid Sparse Retrieval)
CREATE TABLE chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    document_version_id UUID NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
    chunk_offset INT NOT NULL,
    content TEXT NOT NULL,
    token_count INT NOT NULL,
    content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. embeddings (Denormalized workspace_id for Zero-Join HNSW Pre-Filtering)
CREATE TABLE embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    chunk_id UUID NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    embedding_vector vector(1536) NOT NULL,
    model_name VARCHAR(100) NOT NULL DEFAULT 'text-embedding-3-small',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 2. Mandatory Denormalized Tenant Consistency Invariant
Because `workspace_id` is present on `documents`, `chunks`, and `embeddings`, metadata divergence is strictly prevented by a **mandatory database trigger**:

$$\text{documents.workspace\_id} = \text{chunks.workspace\_id} = \text{embeddings.workspace\_id}$$

```sql
-- Trigger Function: Enforce Chunks workspace_id matches Document workspace_id
CREATE OR REPLACE FUNCTION trg_enforce_chunk_workspace_consistency()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    expected_workspace_id UUID;
BEGIN
    SELECT d.workspace_id INTO expected_workspace_id
    FROM document_versions dv
    JOIN documents d ON dv.document_id = d.id
    WHERE dv.id = NEW.document_version_id;

    IF NEW.workspace_id <> expected_workspace_id THEN
        RAISE EXCEPTION 'Tenant Integrity Violation: chunk workspace_id (%) does not match document workspace_id (%)',
            NEW.workspace_id, expected_workspace_id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_chunks_workspace_integrity
BEFORE INSERT OR UPDATE ON chunks
FOR EACH ROW EXECUTE FUNCTION trg_enforce_chunk_workspace_consistency();

-- Trigger Function: Enforce Embeddings workspace_id matches Chunk workspace_id
CREATE OR REPLACE FUNCTION trg_enforce_embedding_workspace_consistency()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    expected_workspace_id UUID;
BEGIN
    SELECT workspace_id INTO expected_workspace_id
    FROM chunks WHERE id = NEW.chunk_id;

    IF NEW.workspace_id <> expected_workspace_id THEN
        RAISE EXCEPTION 'Tenant Integrity Violation: embedding workspace_id (%) does not match chunk workspace_id (%)',
            NEW.workspace_id, expected_workspace_id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_embeddings_workspace_integrity
BEFORE INSERT OR UPDATE ON embeddings
FOR EACH ROW EXECUTE FUNCTION trg_enforce_embedding_workspace_consistency();
```

---

## Row-Level Security (RLS) Strategy

RLS is enabled on all tables. Because `workspace_id` exists directly on `chunks` and `embeddings`, policies evaluate as fast single-column scalar lookups without multi-table joins:

```sql
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE embeddings ENABLE ROW LEVEL SECURITY;

-- Helper function: Returns workspaces the authenticated caller belongs to
CREATE OR REPLACE FUNCTION auth.current_user_workspaces()
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid();
$$;

-- RLS on documents
CREATE POLICY rls_documents_tenant_isolation ON documents
    FOR ALL
    USING (workspace_id IN (SELECT auth.current_user_workspaces()))
    WITH CHECK (workspace_id IN (SELECT auth.current_user_workspaces()));

-- RLS on document_versions
CREATE POLICY rls_document_versions_tenant_isolation ON document_versions
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM documents d 
            WHERE d.id = document_versions.document_id 
              AND d.workspace_id IN (SELECT auth.current_user_workspaces())
        )
    );

-- Direct scalar RLS on chunks
CREATE POLICY rls_chunks_tenant_isolation ON chunks
    FOR ALL
    USING (workspace_id IN (SELECT auth.current_user_workspaces()))
    WITH CHECK (workspace_id IN (SELECT auth.current_user_workspaces()));

-- Direct scalar RLS on embeddings (No multi-table joins during index evaluation)
CREATE POLICY rls_embeddings_tenant_isolation ON embeddings
    FOR ALL
    USING (workspace_id IN (SELECT auth.current_user_workspaces()))
    WITH CHECK (workspace_id IN (SELECT auth.current_user_workspaces()));
```

---

## Retrieval Function: SECURITY INVOKER with Explicit Authorization

### The Security Vulnerability of Unvalidated SECURITY DEFINER
A `SECURITY DEFINER` function executes with the privileges of its owner (frequently the database owner/superuser), which bypasses table RLS. If a function accepts `filter_workspace_id` and runs `SECURITY DEFINER` without independent authorization, an authenticated user belonging to Workspace $B$ could call `match_workspace_chunks(..., filter_workspace_id = 'wks_A')` and successfully retrieve Workspace $A$'s confidential vectors.

### The Corrected Design: SECURITY INVOKER + Explicit Membership Verification
To guarantee zero cross-tenant leakage:
1. The function is defined as **`SECURITY INVOKER`** (executes under the privileges and RLS context of the calling user `auth.uid()`).
2. The function **explicitly verifies** that the caller is a member of `filter_workspace_id` before executing the query. If the caller is not authorized, it raises an exception or returns an empty set.
3. Because it executes as `SECURITY INVOKER`, table-level RLS on `embeddings`, `chunks`, and `documents` remains active as a redundant defense layer.

```sql
CREATE OR REPLACE FUNCTION match_workspace_chunks (
    query_embedding vector(1536),
    match_threshold float,
    match_count int,
    filter_workspace_id uuid
)
RETURNS TABLE (
    chunk_id uuid,
    document_id uuid,
    content text,
    similarity float
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER -- Executes under the caller's privileges and respects table RLS
SET search_path = public
AS $$
BEGIN
    -- 1. Explicit Authorization Check: Validate caller membership
    IF NOT EXISTS (
        SELECT 1 FROM workspace_members 
        WHERE user_id = auth.uid() AND workspace_id = filter_workspace_id
    ) THEN
        RAISE EXCEPTION 'Access Denied: User % is not authorized for workspace %', 
            auth.uid(), filter_workspace_id;
    END IF;

    -- 2. Scoped Retrieval: Table RLS is ALSO enforced in parallel
    RETURN QUERY
    SELECT
        c.id AS chunk_id,
        dv.document_id AS document_id,
        c.content AS content,
        1 - (e.embedding_vector <=> query_embedding) AS similarity
    FROM embeddings e
    JOIN chunks c ON e.chunk_id = c.id
    JOIN document_versions dv ON c.document_version_id = dv.id
    WHERE e.workspace_id = filter_workspace_id
      AND c.workspace_id = filter_workspace_id
      AND dv.is_superseded = false
      AND (1 - (e.embedding_vector <=> query_embedding)) >= match_threshold
    ORDER BY e.embedding_vector <=> query_embedding
    LIMIT match_count;
END;
$$;
```

---

## Indexing Strategy & Validation

Indexing is structured to satisfy both scalar pre-filtering and high-dimensional vector search without relying on unvalidated operator extensions:

| Table | Index Name | Type | Columns | Purpose |
|---|---|---|---|---|
| `embeddings` | `idx_embeddings_hnsw` | **HNSW** (`vector_cosine_ops`) | `(embedding_vector)` | High-dimensional ANN vector similarity search |
| `embeddings` | `idx_embeddings_workspace_chunk` | **B-tree** | `(workspace_id, chunk_id)` | Fast tenant-level scalar filter and foreign-key joins |
| `chunks` | `idx_chunks_workspace_version` | **B-tree** | `(workspace_id, document_version_id)` | Scoped chunk retrieval by document version |
| `chunks` | `idx_chunks_workspace_id` | **B-tree** | `(workspace_id)` | Tenant-level filtering for sparse search |
| `chunks` | `idx_chunks_content_tsv` | **GIN** | `(content_tsv)` | PostgreSQL full-text / sparse candidate retrieval |
| `documents` | `idx_documents_workspace_created` | **B-tree** | `(workspace_id, created_at DESC)` | Scoped document listing and metadata queries |
| `document_versions` | `idx_doc_versions_active` | **B-tree** | `(document_id, is_superseded)` | Filtering superseded versions |

### Clarification on GIN Indexing for Hybrid Search
In standard PostgreSQL, a composite GIN index on `(workspace_id, content_tsv)` requires the optional `btree_gin` extension to handle the `UUID` column. To avoid unverified extension dependencies, the baseline architecture defines:
1. A standard **B-tree index** on `chunks(workspace_id)`.
2. A standard **GIN index** on `chunks(content_tsv)`.
PostgreSQL's query planner natively combines these two indexes via a **BitmapAnd** index scan during hybrid keyword retrieval (`WHERE workspace_id = $1 AND content_tsv @@ query`). If Phase 1 benchmarking demonstrates measurable gain from `btree_gin`, a composite index may be adopted following empirical validation.

---

## Cache-Key Isolation Architecture

All Redis caching (`06_TECHNICAL_REQUIREMENTS.md §5`) incorporates `workspace_id` as the root namespace:
- **Query Embeddings:** `ctx:wks:<workspace_id>:emb:<model_name>:<sha256(query)>`
- **Retrieval Candidates:** `ctx:wks:<workspace_id>:retrieval:<sha256(query + filters)>` (TTL: 300s, invalidated upon document ingestion)
- **Agent Memory:** `ctx:wks:<workspace_id>:usr:<user_id>:mem:<scope>`

*Security Invariant for Caches:* Cache keys for different workspaces must never collide, even for identical query strings. Embedding cache keys are namespaced by tenant to prevent cross-tenant inference via cache-timing side channels.

---

## Performance Hypotheses & Benchmark Acceptance Criteria

To ensure architectural claims are verified experimentally rather than assumed, Contexta-AI establishes the following **testable benchmark criteria**:

| Metric | Target / Benchmark Criterion | Validation Method |
|---|---|---|
| **Operational Retrieval Latency** | p95 $< 300\text{ms}$ (end-to-end API budget) | Synthetic load test against ECS Fargate cluster |
| **Database Retrieval Execution Target** | p95 $< 45\text{ms}$ execution time for `match_workspace_chunks` | `EXPLAIN (ANALYZE, BUFFERS)` execution timing |
| **ANN Recall Target** | $\ge 95\%$ recall@10 compared to brute-force exact vector search within the tenant partition | Automated recall evaluation harness |
| **Index Traversal Plan** | Query plan must demonstrate index-backed tenant filtering without unindexed full-table sequential scans | `EXPLAIN` plan verification in CI test pipeline |
| **Benchmark Dataset Scale** | 100,000 vectors across 50 simulated workspaces | Staged test dataset in CI performance run |

---

## Testing & Validation Strategy

The non-negotiable security invariant will be verified in CI through dedicated automated security tests:

1. **Cross-Tenant Vector Isolation Test (`tests/security/vector_isolation.test.ts`):**
   - **Scenario 1 (Application Query):** Seed Workspace $A$ with confidential test data ("Project Apollo launch date is Oct 12"). Seed Workspace $B$ with generic data. Execute search from Workspace $B$ user context &rarr; assert 0 results returned.
   - **Scenario 2 (Direct RPC Parameter Forgery):** Authenticated User in Workspace $B$ directly calls `match_workspace_chunks` passing `filter_workspace_id = Workspace_A_UUID`. Assert that the database raises an explicit `Access Denied` exception.
   - **Scenario 3 (RLS Defense-in-Depth):** Attempt a raw SQL `SELECT * FROM embeddings WHERE workspace_id = Workspace_A_UUID` under User $B$'s authenticated connection. Assert that PostgreSQL RLS returns 0 rows.
   - **Scenario 4 (Concurrent Workspace Multi-Tenancy):** Execute 50 concurrent retrieval queries alternating between Workspace $A$ and Workspace $B$. Assert zero cross-tenant contamination across all returned sets.
   - **Scenario 5 (Cache Isolation):** Execute query $Q$ in Workspace $A$; execute identical query $Q$ in Workspace $B$. Verify that Workspace $B$ does not receive a cache hit from Workspace $A$'s key.
2. **Execution Plan Validation:**
   - Execute `EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM match_workspace_chunks(...)`.
   - Verify that the plan confirms index usage on `idx_embeddings_hnsw` and `idx_embeddings_workspace_chunk`, validating that tenant filtering is enforced at the database layer without unindexed sequential table scans.

---

## Impact on Existing Documentation

Following the ratification of this ADR, the documentation suite will be updated during the baseline freeze:

| Document | Required Reconciliation Update |
|---|---|
| **`09_DATABASE_DESIGN.md`** | **Critical Update:** Update Table Specifications §6.7 (`chunks`) and §6.8 (`embeddings`) to add `workspace_id UUID NOT NULL REFERENCES workspaces(id)`. Update ER diagram (§5), RLS policy specifications (§7), and Vector Search (§8) with `match_workspace_chunks`. |
| **`11_SECURITY_ARCHITECTURE.md`** | Remove provisional assumption tags in §7.1 and §7.2; ratify Hybrid Defense-in-Depth and `SECURITY INVOKER` authorization. |
| **`08_AI_ARCHITECTURE.md`** | Update Retrieval Pipeline (§8) to reference `match_workspace_chunks` pre-filtered retrieval contract. |
| **`06_TECHNICAL_REQUIREMENTS.md`** | Update `TR-DAT-1` and `TR-SEC-2` to reflect the 4-tier vector isolation model. |
| **`07_SYSTEM_ARCHITECTURE.md`** | Update Data Layer interaction diagrams (§6). |
| **`10_API_SPECIFICATION.md`** | Affirm that `/v1/workspaces/:workspace_id/*` retrieval endpoints pass tenant context to the database session. |
| **`14_TESTING_STRATEGY.md`** | Add §11.3 detailing the automated Cross-Tenant Vector Leakage test harness. |
| **`DOCUMENTATION_SUITE_REVIEW_REPORT.md`** | Mark **GAP-P0-01** as formally resolved by ADR-0002. |

---

## Impact on Existing Code

The following code areas in the repository are affected and scheduled for refactoring during the Phase 1 milestone:
- `supabase/migrations/`: Create a new migration creating the normalized tables `documents`, `document_versions`, `chunks`, and `embeddings` with `workspace_id`, consistency triggers, composite indexes, and `SECURITY INVOKER` search functions.
- `packages/retrieval/src/index.ts`: Refactor `makeSupabaseRetriever` to call `match_workspace_chunks` passing the authenticated `workspace_id`, replacing the legacy `match_documents` function.
- `apps/api/src/services/runs.service.ts`: Ensure `workspace_id` is bound to vector search calls.

*Note: Application code will not be modified within this decision task. Implementation will proceed under the Phase 1 database milestone.*

---

## Alternatives Rejected

1. **Relational Joins Only (Option B):** 3-table joins during vector graph traversal cause severe latency and catastrophic recall collapse under `pgvector` index scans.
2. **Unvalidated `SECURITY DEFINER` RPC Functions:** Rejected due to the critical security risk of allowing callers to bypass table RLS by supplying foreign workspace UUIDs.
3. **Database-Per-Tenant (Silo Model):** Prohibitive operational overhead and infrastructure cost for SaaS multi-tenancy across thousands of workspaces.
4. **Application-Only Post-Filtering:** Discarding cross-tenant vectors in Node.js memory after a global vector search causes extreme recall starvation and side-channel timing leaks.

---

## Risks and Mitigations

| Identified Risk | Severity | Mitigation Strategy |
|---|:---:|---|
| **Data Redundancy & Synchronization Drift** | Low | Enforce mandatory database triggers `trg_chunks_workspace_integrity` and `trg_embeddings_workspace_integrity` guaranteeing identical `workspace_id` across the hierarchy. |
| **Storage Overhead** | Low | Storing a UUID column (16 bytes) increases table storage by $<1\%$, an inconsequential tradeoff for sub-second retrieval and multi-tenant security. |
| **Cross-Tenant ANN Recall & Traversal Interference** | Medium | In shared approximate indexes, other tenants' vectors can impact traversal speed and recall. Mitigate via `pgvector` 0.8.0+ iterative scanning with `hnsw.ef_search = 100`. Benchmark in Phase 1; if cross-tenant degradation exceeds recall targets at scale, evaluate declarative PostgreSQL table partitioning by `workspace_id`. |

---

## Decision Outcome

**ADR-0002 is formally ACCEPTED.** Contexta-AI adopts the **Hybrid Defense-in-Depth Strategy** for Vector Tenancy Isolation. The physical schema for `chunks` and `embeddings` will denormalize `workspace_id` backed by mandatory consistency triggers, `SECURITY INVOKER` stored functions with explicit caller-membership authorization, and a 4-tier security boundary across the Gateway, Application, Database, and Cache layers.

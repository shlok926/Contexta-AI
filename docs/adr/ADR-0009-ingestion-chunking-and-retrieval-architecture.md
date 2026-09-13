# ADR-0009: Ingestion, Chunking & Retrieval Architecture

- **Status:** Accepted
- **Date:** 2026-09-12
- **Decision Owners:** Contexta-AI Architecture
- **Decision:** Adopt **Option B: Asynchronous Decoupled Ingestion + Structure-Aware Hierarchical Chunking + Hybrid Dense/Sparse Retrieval + Reciprocal Rank Fusion (RRF) + Cross-Encoder Reranking** as the canonical ingestion and retrieval architecture for Contexta-AI. Document ingestion is physically decoupled from synchronous HTTP request lifecycles via an asynchronous worker executing against a strongly-typed `AuthorizedJobEnvelope` (a conceptual execution and provenance contract). Ingestion execution adheres to an at-least-once delivery, retryable execution, single-writer concurrency-controlled, and idempotent persistence reliability model, preserving the frozen 15-entity relational schema of ADR-0007 without introducing new tables. Worker execution does not retain, replay, or impersonate caller bearer tokens and does not inherit `service_role` authority merely by being a background task; background database operations execute under ADR-0008's authorized background execution mechanism. Documents are parsed into a normalized structural representation and chunked via Structure-Aware Hierarchical Chunking (structural headings $\rightarrow$ paragraphs/blocks $\rightarrow$ sentences $\rightarrow$ token budget). Synthetic breadcrumbs injected to enrich embedding context are strictly quarantined from evidence content: raw extracted source text is preserved in `chunks.content` and exposed in the `EvidencePackage`. Only document versions in `status = 'ready' AND is_current = true` participate in retrieval; the atomic document-version activation transaction is the authoritative retrieval visibility boundary. Retrieval combines dense pgvector HNSW cosine-distance search with sparse PostgreSQL Full-Text Search (`tsvector` via GIN), fused via Reciprocal Rank Fusion (RRF) and refined by a cross-encoder reranker. Unbounded sequential vector scans are strictly prohibited in production. Retrieval performs relevance discovery, not truth verification; the resulting `EvidencePackage` is passed to the ADR-0003 Entailment Gate for claim verification.
- **Governing Architecture:** `00_PROJECT_CONSTITUTION.md §5, §13`, `05_PRODUCT_REQUIREMENTS.md §FR-DOC-*, §FR-RET-*`, `06_TECHNICAL_REQUIREMENTS.md §TR-RET-*, §TR-ING-*`, `07_SYSTEM_ARCHITECTURE.md §7`, `08_AI_ARCHITECTURE.md §6-8`, `09_DATABASE_DESIGN.md §7`, `10_API_SPECIFICATION.md §8`, `11_SECURITY_ARCHITECTURE.md §6-8`, `ADR-0001` (NestJS Modular Monolith Framework), `ADR-0002` (Vector Tenancy Isolation), `ADR-0003` (Citation Entailment & Hallucination Guard), `ADR-0004` (Canonical Memory Architecture & Tenancy Model), `ADR-0005` (Agent Graph Architecture & Execution Flow), `ADR-0006` (API Contract & Streaming Specification Reconciliation), `ADR-0007` (Database Schema & Persistence Reconciliation), `ADR-0008` (Identity, Authentication, Authorization & RBAC Architecture).

---

## Decision Summary

1. **Decoupled Ingestion Pipeline:** Document processing (text extraction, structural parsing, hierarchical chunking, vector embedding generation, and sparse search vector creation) is entirely removed from synchronous HTTP gateway handlers. API endpoints accept uploads, record initial version metadata in `document_versions` (`status = 'processing', is_current = false`), and emit an `AuthorizedJobEnvelope` to an asynchronous delivery mechanism.
2. **Reliability & Concurrency Contract:** 
   - **Delivery:** At-least-once delivery (explicitly accommodates duplicate or redelivered job messages).
   - **Execution:** Retryable with bounded exponential backoff.
   - **Concurrency Control:** Single-writer mutual exclusion per `document_version_id`. At most one worker execution may mutate the staging, chunking, or embedding index state for a given `document_version_id` at a time.
   - **Effects:** Idempotent database operations. Retries clear previously written partial records within a transactional boundary before persisting clean state, converging deterministically without duplicate retrieval records.
   - **Schema Fidelity:** Concurrency control and execution tracking require zero new database entities, operating strictly within the 15 canonical entities frozen in ADR-0007.
3. **Worker Authorization & Least Privilege:** The ingestion worker does not retain, replay, or impersonate the originating user's bearer token. The caller-supplied `workspace_id` and `actor_user_id` inside the `AuthorizedJobEnvelope` establish execution target scope and audit provenance, but are not themselves authorization credentials. The worker does not inherit `service_role` authority merely because it runs asynchronously. Tenant-scoped background execution runs under ADR-0008's authorized background execution mechanism, preserving the ADR-0002 RLS boundary. Exceptional administrative/system re-indexing must satisfy ADR-0008's privileged execution criteria (trusted system identity, explicit workspace target, allowlisted operation, structured audit trail).
4. **Structure-Aware Hierarchical Chunking:** Replaces fixed sliding character windows and ungrounded "semantic" chunking with deterministic structural decomposition. Documents across PDF, DOCX, Markdown, and Plain Text are parsed into a normalized structural representation and segmented hierarchically: structural headers $\rightarrow$ section/paragraph blocks $\rightarrow$ sentence boundaries $\rightarrow$ token budget accumulation (Phase-1 default: 512 tokens with 64-token overlap).
5. **Breadcrumb & Provenance Quarantine:** Synthetic contextual breadcrumbs (e.g. `[Document: Title | Section: H1 > H2]`) are added exclusively to the string presented to the dense embedding model. The raw extracted source text is preserved verbatim in `chunks.content`. Synthetic breadcrumbs must **never** become citation evidence; the citation verifier (ADR-0003) verifies claims strictly against raw source text. Provenance is tracked format-agnostically in `ChunkProvenance` with nullable `page_number` and deterministic structural/character offsets.
6. **Atomic Version Activation & Retrieval Visibility Boundary:** A document version participates in retrieval if and only if `status = 'ready' AND is_current = true`. A replacement version (`v2`) in `status = 'processing'` or `status = 'failed'` does not interrupt or invalidate the retrievability of an existing active version (`v1`). Atomic activation occurs via a single database transaction deactivating `v1` (`is_current = false`) and activating `v2` (`status = 'ready', is_current = true`).
7. **Hybrid Dense/Sparse Retrieval with RRF & Reranker:** Retrieval executes dual tenant-scoped queries:
   - **Dense Vector Search:** Cosine similarity via pgvector HNSW on `embeddings.embedding`, pre-filtered by `workspace_id`.
   - **Sparse Full-Text Search:** PostgreSQL Full-Text Search (`websearch_to_tsquery` against `chunks.tsv` via GIN), scored by `ts_rank_cd` and pre-filtered by `workspace_id`.
   - **Rank Fusion:** Reciprocal Rank Fusion (RRF, default $k = 60$) merges dense and sparse rankings into a unified candidate set without cross-score calibration.
   - **Precision Reranking:** A cross-encoder reranker scores the top fused candidates against the raw query and raw source content, producing the final ranked candidate set.
8. **Bounded Fallback Protection:** Unbounded sequential vector scans are strictly prohibited in production. If the HNSW vector index is degraded, corrupted, or unavailable, the system safely falls back to FTS-only retrieval or an explicitly bounded, benchmarked vector fallback with strict execution timeouts.
9. **ADR-0003 Truth Boundary:** Retrieval is **relevance discovery**, not factual verification. Retrieval emits an `EvidencePackage` containing candidate raw evidence chunks and source provenance. The ADR-0003 Entailment Gate evaluates whether the candidate evidence logically entails the generated answer claims (`Evidence ⊨ Claim`).

---

## 1. Context

Contexta-AI provides multi-agent enterprise intelligence grounded in organizational knowledge bases. Ingesting, segmenting, indexing, and retrieving this knowledge requires a rigorous architectural foundation reconciling several core requirements:

1. **Diverse Multi-Format Ingestion:** Workspaces ingest varied document formats, including structured Markdown, paginated PDFs, multi-section DOCX files, and unstructured Plain Text. Each format possesses different structural properties, page semantics, and extraction complexities.
2. **Gateway Protection & Resource Isolation:** Ingesting large documents (e.g., 50–100+ pages) requires intensive compute: text extraction, structural normalization, tokenization, batch embedding API calls, and GIN/HNSW index writes. Executing these operations synchronously inside HTTP request handlers causes gateway timeouts (e.g., 30-second reverse-proxy limits), memory spikes, connection pool starvation, and degraded interactive API responsiveness.
3. **Preserving Structural Context:** Naive fixed-size character- or token-window chunking arbitrarily severs paragraphs, tables, lists, and code blocks. Such fragmentation strips local context, separates headings from their parent sections, and severely impairs both semantic embedding retrieval and exact keyword search.
4. **Hybrid Retrieval (Dense + Sparse):** Pure dense vector search excels at conceptual and semantic queries but fails on exact keyword lookups, alphanumeric identifiers, entity names, error codes, and technical jargon. Conversely, pure keyword search fails on paraphrased natural language queries. A robust retrieval architecture must combine dense semantic retrieval with PostgreSQL Full-Text Search (FTS).
5. **Strict Multi-Tenant Isolation:** Documents and embeddings are strictly isolated by workspace. As established in ADR-0002 and ADR-0008, PostgreSQL Row-Level Security (RLS) is the authoritative database isolation boundary, enforced via `SECURITY INVOKER` and pre-filtered by `workspace_id`.
6. **Provenance & The ADR-0003 Evidence Boundary:** ADR-0003 established a deterministic two-stage cascade requiring claims to be entailed by verifiable evidence (`Evidence ⊨ Claim`). If ingestion pollutes stored chunk text with synthetic annotations or fails to record precise document source locations, citation verification fails or validates against synthetic content not present in the original document.
7. **Frozen Relational Baseline:** ADR-0007 established a frozen 15-entity schema (`organizations`, `users`, `workspaces`, `workspace_members`, `threads`, `messages`, `agent_runs`, `agent_run_steps`, `audit_logs`, `documents`, `document_versions`, `chunks`, `embeddings`, `citations`, `memory_entries`). The ingestion and retrieval architecture must operate strictly within these 15 entities without introducing auxiliary relational tables (such as `jobs`, `background_jobs`, or `api_keys`).

---

## 2. Problem Statement

Contexta-AI requires an architectural standard resolving the following operational and technical challenges:
1. **Synchronous Ingestion Fragility:** Ingestion must not execute on the synchronous request thread, while preserving transparent status tracking and robust error recovery.
2. **Reliability & Redelivery Concurrency:** In the absence of a dedicated distributed queue cluster in Phase 1, the delivery mechanism must provide at-least-once processing guarantees without risking concurrent execution races or duplicate chunk records during worker retries.
3. **Worker Privilege Drift:** Background workers must not be granted broad `service_role` database bypass authority simply because they operate asynchronously, and must not compromise security by retaining or replaying user bearer tokens.
4. **Chunk Fragmentation & Provenance Loss:** Chunking must preserve document structure without creating artificial semantic boundaries, and must capture precise, format-agnostic provenance.
5. **Retrieval Precision & Noise:** Dense retrieval produces false positives in large corpora; sparse search misses semantic synonyms. The pipeline must synthesize dense and sparse candidates and refine them with cross-encoder precision before passing evidence to downstream agents.
6. **Relevance Discovery vs. Claim Entailment:** Clear architectural separation must be maintained between the retrieval of relevant context (ADR-0009) and the verification of factual truth (ADR-0003).

---

## 3. Decision Drivers

- **Modular Monolith Alignment (ADR-0001):** Clean encapsulation within `IngestionModule` and `RetrievalModule`, decoupled via NestJS dependency injection.
- **Tenant Isolation & RLS Boundary (ADR-0002):** PostgreSQL RLS as the authoritative query boundary, reinforced by application-level `workspace_id` filtering.
- **Citation Entailment & Verifier Boundary (ADR-0003):** Raw source text preservation for strict claim entailment; synthetic metadata quarantined from citation evidence.
- **15-Entity Schema Fidelity (ADR-0007):** Strict persistence into `documents`, `document_versions`, `chunks`, `embeddings`, and `citations`.
- **Identity & Worker Governance (ADR-0008):** Least-privileged background execution; no bearer token replay; no automatic `service_role` assumption; `AuthorizedJobEnvelope` as execution contract.
- **HTTP Gateway Protection & Throughput:** Offloading CPU- and I/O-intensive ingestion from the synchronous HTTP request path.
- **Structural Preservation:** Maintaining headings, paragraphs, lists, and sections to avoid fragmented context.
- **Recall & Precision:** Hybrid dense (pgvector) + sparse (PostgreSQL FTS) retrieval fused via RRF and reranked via cross-encoder.
- **Format-Agnostic Provenance:** Uniform location tracking across PDF, DOCX, Markdown, and Plain Text.
- **Fault Tolerance & Concurrency Control:** At-least-once delivery, retryable execution, single-writer mutual exclusion per document version, and idempotent effects.
- **Operational Simplicity & Cost:** Leveraging existing PostgreSQL infrastructure without premature distributed queue or search engine clustering.

---

## 4. Options Considered

Four primary architectural options were evaluated in the approved Architectural Decision Analysis:

1. **Option A: Monolithic Synchronous Ingestion & Dense-Only Vector Search**
   - Synchronous document processing within the HTTP request handler.
   - Fixed-size sliding character chunking.
   - Pure dense vector retrieval using pgvector cosine distance.
   - *Rejected:* Causes gateway timeouts on multi-page files, produces fragmented chunks, suffers poor keyword recall, and lacks reranking precision.
2. **Option B: Asynchronous Decoupled Ingestion, Structure-Aware Hierarchical Chunking & Hybrid Dense-Sparse RRF + Rerank (Selected)**
   - Asynchronous worker decoupled via an `AuthorizedJobEnvelope`.
   - At-least-once delivery, retryable execution, single-writer concurrency control, and idempotent writes.
   - Structure-Aware Hierarchical Chunking across normalized structural representations.
   - Separation of synthetic embedding breadcrumbs from raw source evidence.
   - Hybrid dense (pgvector HNSW) + sparse (PostgreSQL FTS GIN) search fused via RRF and reranked via cross-encoder.
   - Strict adherence to ADR-0007 (15 entities) and ADR-0008 (least-privileged worker).
3. **Option C: Event-Driven Distributed Microservices with External Queue & OpenSearch**
   - Separate ingestion microservices coordinated via Apache Kafka or RabbitMQ.
   - External OpenSearch/Elasticsearch cluster for sparse search; dedicated vector DB.
   - *Rejected:* Violates the NestJS modular monolith baseline (ADR-0001), violates the 15-entity schema baseline (ADR-0007), introduces massive infrastructure operational overhead, and bypasses PostgreSQL RLS (ADR-0002).
4. **Option D: External Managed RAG SaaS Pipeline (e.g., Unstructured.io + Pinecone)**
   - Complete delegation of ingestion, chunking, and retrieval to third-party hosted APIs.
   - *Rejected:* Breaks data residency and enterprise privacy guarantees, externalizes the persistence model, bypasses PostgreSQL RLS, creates vendor lock-in, and introduces unpredictable per-query SaaS costs.

### 4.1 Normalized Decision Matrix

The evaluation criteria weights sum to **exactly 100%**. Scores are evaluated on a 1–10 scale:

$$\text{Total Score} = \sum_{i=1}^{11} (\text{Weight}_i \times \text{Score}_i)$$

| # | Architectural Criterion | Weight (%) | Option A | Option B (Selected) | Option C | Option D |
| :-: | :--- | :-: | :-: | :-: | :-: | :-: |
| 1 | **Monolith Alignment (ADR-0001)** | **9%** | 8 (0.72) | **10 (0.90)** | 3 (0.27) | 4 (0.36) |
| 2 | **Tenancy & RLS Boundary (ADR-0002)** | **11%** | 5 (0.55) | **10 (1.10)** | 4 (0.44) | 3 (0.33) |
| 3 | **Citation & Verifier Boundary (ADR-0003)** | **11%** | 4 (0.44) | **10 (1.10)** | 7 (0.77) | 5 (0.55) |
| 4 | **15-Entity Schema Fidelity (ADR-0007)** | **11%** | 9 (0.99) | **10 (1.10)** | 1 (0.11) | 1 (0.11) |
| 5 | **Authorization & Worker Governance (ADR-0008)** | **11%** | 7 (0.77) | **10 (1.10)** | 5 (0.55) | 4 (0.44) |
| 6 | **HTTP Gateway Protection & Throughput** | **9%** | 1 (0.09) | **9 (0.81)** | 10 (0.90) | 9 (0.81) |
| 7 | **Structure & Provenance Preservation** | **8%** | 3 (0.24) | **10 (0.80)** | 8 (0.64) | 6 (0.48) |
| 8 | **Semantic + Keyword Retrieval Recall** | **9%** | 4 (0.36) | **9.5 (0.855)** | 9 (0.81) | 6 (0.54) |
| 9 | **Precision & Cross-Encoder Reranking** | **8%** | 2 (0.16) | **9.5 (0.76)** | 9 (0.72) | 5 (0.40) |
| 10 | **Operational Simplicity & Cost** | **8%** | 9 (0.72) | **9 (0.72)** | 2 (0.16) | 4 (0.32) |
| 11 | **Idempotency & Fault Tolerance** | **5%** | 2 (0.10) | **9 (0.45)** | 9 (0.45) | 6 (0.30) |
| **Σ** | **Normalized Total** | **100%** | **5.14 / 10** | **9.70 / 10** | **5.82 / 10** | **4.64 / 10** |

**Selection Decision:** Option B is the approved canonical architecture with a score of **9.70 / 10**.

---

## 5. Ingestion Architecture

The canonical ingestion pipeline completely separates synchronous request validation from asynchronous execution:

```
Upload Request
     │
     ▼
HTTP API Controller (JwtAuthGuard + WorkspaceMemberGuard + PermissionsGuard)
     │
     ▼
Document Version Creation (document_versions: status = 'processing', is_current = false)
     │
     ▼
AuthorizedJobEnvelope (Immutable execution contract & provenance carrier)
     │
     ▼
Physical Delivery Mechanism (At-least-once dispatch & redelivery)
     │
     ▼
Asynchronous Worker (Single-writer concurrency lock on document_version_id)
     │
     ▼
Document Extraction (PDF, DOCX, Markdown, Plain Text)
     │
     ▼
Text Normalization (Encoding, line-endings, control characters)
     │
     ▼
Normalized Structural Representation (Headings, blocks, lists, tables)
     │
     ▼
Structure-Aware Hierarchical Chunking (Structural bounds → token budget)
     │
     ▼
Canonical Chunks (Raw source text + format-agnostic ChunkProvenance)
     │
     ├───────────────────────────────────────┐
     ▼                                       ▼
Dense Embeddings (HNSW)                 Sparse Search Index (GIN)
(Breadcrumb + Raw Text)                 (Raw Source Text → tsvector)
     │                                       │
     └───────────────────┬───────────────────┘
                         ▼
             Atomic Version Activation
 (document_versions: status = 'ready', is_current = true [ONE TRANSACTION])
```

### 5.1 Pipeline Decoupling & Conceptual Distinctions

To prevent operational ambiguity, the architecture explicitly distinguishes three independent layers:
1. **The `AuthorizedJobEnvelope`:** The conceptual execution contract and auditable provenance record. It defines *what* authorized work must occur.
2. **The Physical Delivery Mechanism:** The delivery and redelivery infrastructure (e.g., in-process job queue augmented by database reconciliation loops, or external durable queue adapters). It defines *how* messages are dispatched and retried.
3. **The Worker:** The execution runtime that executes extraction, chunking, and indexing. It defines *where* compute runs.

Equating the conceptual job envelope with an in-memory queue or assuming an in-process worker automatically guarantees durability is strictly prohibited.

---

## 6. The AuthorizedJobEnvelope

The `AuthorizedJobEnvelope` is an immutable, strongly-typed execution contract established by ADR-0008:

```typescript
interface AuthorizedJobEnvelope<T = IngestionPayload> {
  job_id: string;                      // Unique execution UUID
  correlation_id: string;              // End-to-end distributed tracing ID
  workspace_id: string;                // Authoritative tenant scope
  actor_user_id: string;               // Originating authenticated user identity
  target_resource_id: string;          // document_version_id being processed
  operation: 'ingest_document_version';// Explicit allowlisted operation name
  payload: T;                          // Storage file reference, MIME type, doc metadata
  created_at: string;                  // ISO-8601 creation timestamp
  claims_snapshot: {                   // Auditable auth claims from JWT validation
    sub: string;
    role: string;
    auth_event_id?: string;
  };
}

interface IngestionPayload {
  document_id: string;
  storage_path: string;
  file_name: string;
  mime_type: string;
  file_size_bytes: number;
}
```

### 6.1 Critical Security Invariant: Provenance vs. Authority

> [!CRITICAL]
> `workspace_id` and `actor_user_id` inside the `AuthorizedJobEnvelope` establish the authorized execution target and audit provenance; **they are NOT authorization credentials**. 
> 
> The worker must not treat caller-supplied identifiers as self-authorizing. The presence of a `workspace_id` in a payload does not grant the worker permission to bypass security policies or fabricate database privileges.

---

## 7. Delivery, Reliability & Concurrency Model

The ingestion architecture establishes a four-pillar reliability model:

$$\text{Delivery: At-Least-Once} \quad\vert\quad \text{Execution: Retryable} \quad\vert\quad \text{Concurrency: Single-Writer} \quad\vert\quad \text{Effects: Idempotent}$$

Because physical networks and worker processes can crash or time out, at-least-once delivery inherently implies that duplicate or overlapping job redeliveries can occur. The system must remain safe and deterministic under redelivery.

### 7.1 Architectural Concurrency & Reliability Invariants

1. **Worker Serialization & Concurrency Control:** Worker executions for the same `document_version_id` must be serialized or otherwise concurrency-controlled.
2. **Single-Writer Mutation:** At most one ingestion execution may mutate the staging, chunking, or embedding index state for a given `document_version_id` at any given time.
3. **Safe Redelivery Behavior:** Redelivered executions must safely wait for, retry after, or supersede an existing execution according to an implementation-defined concurrency-control mechanism.
4. **Implementation-Level Concurrency Mechanism:** The exact concurrency-control mechanism remains an implementation detail and is not frozen to a single database primitive in ADR-0009. Acceptable implementations include:
   - PostgreSQL transaction-scoped advisory locks (`pg_try_advisory_xact_lock`).
   - Row-level conditional locking / state-transition checks on `document_versions`.
   - Partition-keyed queue delivery (ensuring same-version jobs route to serialized consumers).
5. **Preservation of ADR-0007 15-Entity Schema:** The concurrency-control mechanism must not introduce any new persistent database entities or tables (such as `jobs` or `locks`); it must operate entirely using transient runtime locks or existing fields on `document_versions`.
6. **Deterministic Convergence:** Worker retries must converge deterministically to the identical chunk and embedding representation without producing orphan, duplicate, or dangling records.
7. **Single Active Representation:** A document version may have at most one active set of chunks and embeddings participating in retrieval. Retries clear previously written partial records within a single database transaction before writing fresh records.
8. **Visibility Isolation:** The atomic document-version activation transaction remains the sole retrieval visibility boundary. Duplicate job executions cannot leak uncommitted or partial chunks into the retrieval engine.

*Exactly-once delivery or exactly-once execution is explicitly rejected as an architectural claim.*

---

## 8. Worker Authorization Boundary

The ingestion worker operates under strict least-privilege boundaries reconciling ADR-0008:

1. **No Token Retention or Replay:** Asynchronous workers must **never** retain, persist, or replay the originating caller's raw Bearer JWT. User session tokens expire and must not live inside background queue stores.
2. **No User Impersonation:** Workers must not forge or fabricate synthetic user JWTs.
3. **No Automatic `service_role` Assumption:** The ingestion worker does **not** automatically receive or inherit Supabase `service_role` authority merely because it runs asynchronously. Defaulting to `SUPABASE_SERVICE_ROLE_KEY` for normal ingestion writes is prohibited.
4. **Authorized Background Execution:** Normal user-initiated ingestion executes against the database using ADR-0008's authorized background execution mechanism, preserving PostgreSQL RLS enforcement at the SQL query boundary. The concrete database context-propagation mechanism remains an implementation detail unless separately frozen by an ADR.
5. **Privileged System Ingestion Quarantined:** Platform-level batch re-indexing, schema migrations, or administrative repairs requiring elevated database privileges are classified as exceptional **Privileged Service Operations** under ADR-0008, requiring:
   - Origin from a verified, trusted internal system identity.
   - An explicit, declared target `workspace_id`.
   - An allowlisted operation name (`'system_reindex_workspace'`).
   - Mandatory structured audit event logging in `audit_logs`.
   - Total isolation from normal user-triggered upload flows.

---

## 9. Chunking Architecture: Structure-Aware Hierarchical Chunking

The canonical chunking algorithm is formally designated **Structure-Aware Hierarchical Chunking**. It rejects arbitrary fixed-length character slicing and machine-learned semantic boundary segmentation in favor of deterministic structural decomposition:

```
Document Raw Text
     │
     ▼
Normalized Structural Representation (AST / Block Model / Layout Tree)
     │
     ▼
Structural Header Splitting (H1, H2, H3 / Document Outline)
     │
     ▼
Paragraph & Section Blocks (Double-newline / Container boundaries)
     │
     ▼
Sentence Decomposition (Punctuation- & abbreviation-aware)
     │
     ▼
Token Budget Accumulation (Target: 512 tokens, Overlap: 64 tokens)
```

### 9.1 Decomposition Rules

1. **Structural Normalization:** The document parser converts source files into a format-agnostic structural model:
   - **Markdown:** Markdown Abstract Syntax Tree (AST) preserving headers, code blocks, lists, and tables.
   - **DOCX:** Block-level document model preserving styles, headings, paragraphs, and table structures.
   - **PDF:** Layout tree preserving font-size hierarchies, geometric blocks, and detected headings.
   - **Plain Text:** Structural text blocks delineated by multi-newline paragraph boundaries.
2. **Hierarchical Boundary Preferences:** Chunk boundaries are determined by prioritizing natural semantic transitions:
   - *Preference 1 (Highest):* Major section and heading transitions (`H1`, `H2`, `H3`). Chunks should avoid spanning across major section headings.
   - *Preference 2:* Paragraph and block container boundaries.
   - *Preference 3:* Sentence boundaries (using punctuation rules aware of common abbreviations and numeric decimals).
   - *Preference 4 (Fallback):* Whitespace-delimited word tokens when a single sentence exceeds the token budget.
3. **Boundary Integrity:** Code blocks, markdown tables, and numbered lists are preserved intact within a single chunk whenever their token size fits within the token budget. If a table or code block exceeds the budget, it is split along line boundaries while carrying header context forward.
4. **Token Budget & Overlap Governance:**
   - **Target Chunk Size:** Phase-1 default is **512 tokens** (measured via `cl100k_base` tokenizer).
   - **Chunk Overlap:** Phase-1 default is **64 tokens**. Overlap tokens are drawn from the terminal sentences of the preceding chunk within the same structural section to preserve local co-reference without crossing major heading boundaries.
   - *Classification:* These values are **tunable Phase-1 defaults**, not immutable architectural constants.

---

## 10. Breadcrumb & Embedding Provenance Boundary

To enrich dense vector search with document hierarchy while rigorously preserving the truth boundary of ADR-0003, ingestion enforces an absolute separation between **Embedding Text** and **Evidence Content**:

```
                       CHUNK GENERATION
                              │
                              ▼
           Raw Source Text (Exact extracted characters)
                              │
             ┌────────────────┴────────────────┐
             ▼                                 ▼
   chunks.content                     chunks.metadata
 (Immutable Raw Source)            (Format-Agnostic Provenance)
             │                                 │
             ▼                                 ▼
      EvidencePackage                   Synthetic Breadcrumb
 (Delivered to ADR-0003)        "[Doc: Title | Sec: H1 > H2]"
             │                                 │
             │        ┌────────────────────────┘
             ▼        ▼
       Combined Text String: `breadcrumb + "\n" + raw_source_text`
                      │
                      ▼
           Dense Embedding Model
                      │
                      ▼
            embeddings.embedding
```

### 10.1 The Hard Provenance Invariant

> [!IMPORTANT]
> **Synthetic breadcrumbs must NEVER become citation evidence.**
> 
> The text input to the dense embedding model consists of the synthetic breadcrumb prepended to the raw chunk text. However, `chunks.content` stores exclusively the raw extracted source text. 
> 
> The `EvidencePackage` presented to the ADR-0003 Entailment Gate exposes only raw source text. The citation verifier verifies claims against what was actually written in the original document, not against synthetic contextual labels generated during indexing.

---

## 11. Generic Provenance Contract Across Formats

Document provenance must be format-agnostic, providing deterministic source tracking whether a document has physical pages or continuous text. Ingestion populates `chunks.metadata` with the canonical `ChunkProvenance` contract:

```typescript
interface ChunkProvenance {
  document_id: string;                 // Foreign key to documents.id
  document_version_id: string;         // Foreign key to document_versions.id
  workspace_id: string;                // Multi-tenant scope
  source_location: {
    page_number: number | null;        // Non-null for PDF/paginated; null for Markdown/TXT/DOCX
    character_start: number;           // 0-indexed start offset in normalized document string
    character_end: number;             // 0-indexed end offset in normalized document string
    block_index: number;               // Sequential structural block identifier
    structural_path: string[];         // e.g. ["Chapter 3: Architecture", "3.2 Chunking"]
    document_relative_offset: number;  // Normalized document progression [0.0 - 1.0]
  };
  chunk_index: number;                 // Sequential chunk index within the version (0-based)
  token_count: number;                 // Exact token length of raw source text
}
```

- **Format Independence:** Paginated documents (PDF) populate `page_number`; unpaginated documents (Markdown, Plain Text, DOCX) leave `page_number = null` and rely on `character_start`, `character_end`, and `structural_path`.
- **Deterministic Offsets:** Character offsets are calculated against the normalized text representation, ensuring exact reproducible slice locations.

---

## 12. Document Version Lifecycle & Retrieval Visibility Boundary

Document versions follow a deterministic lifecycle under ADR-0007. Retrieval queries must enforce strict active-version semantics:

```
State T1 (Initial Baseline):
  Document Version v1: status = 'ready', is_current = true       ──► RETRIEVABLE
  Document Version v2: status = 'processing', is_current = false  ──► NOT RETRIEVABLE

State T2a (Ingestion of v2 succeeds):
  BEGIN TRANSACTION;
    UPDATE document_versions SET is_current = false 
      WHERE document_id = :id AND is_current = true;
    UPDATE document_versions SET status = 'ready', is_current = true 
      WHERE id = :v2_id;
  COMMIT;
  Result:
  Document Version v1: status = 'ready', is_current = false       ──► ARCHIVED (NOT RETRIEVABLE)
  Document Version v2: status = 'ready', is_current = true        ──► ACTIVE (RETRIEVABLE)

State T2b (Ingestion of v2 fails):
  UPDATE document_versions SET status = 'failed' WHERE id = :v2_id;
  Result:
  Document Version v1: status = 'ready', is_current = true       ──► UNINTERRUPTED (RETRIEVABLE)
  Document Version v2: status = 'failed', is_current = false      ──► FAILED (NOT RETRIEVABLE)
```

### 12.1 The Retrieval Visibility Invariant

> [!CRITICAL]
> A chunk participates in retrieval if and only if its parent document version satisfies:
> 
> $$\text{status} = \text{'ready'} \quad\text{AND}\quad \text{is\_current} = \text{true}$$
> 
> Setting `status = 'ready'` alone is **insufficient** for retrieval visibility. Chunks become visible to retrieval if and only if their parent version is atomically activated as the current version.
> 
> Reprocessing failures are non-destructive: if version `v2` fails processing, version `v1` remains `ready` and `is_current = true`, ensuring continuous, uninterrupted knowledge availability.

---

## 13. Hybrid Retrieval Architecture

Contexta-AI implements a dual-engine hybrid retrieval pipeline combining dense semantic similarity and sparse full-text search, fused via Reciprocal Rank Fusion (RRF) and refined by a cross-encoder reranker:

```
User Query
     │
     ├───────────────────────────────────────┐
     ▼                                       ▼
Dense Vector Retrieval                  Sparse Full-Text Search
- Query Embedding Generation            - PostgreSQL websearch_to_tsquery('english', :query)
- Cosine Distance (`<=>`) in pgvector   - Matched against chunks.tsv via GIN
- Tenant Filter: workspace_id           - Tenant Filter: workspace_id
- Version Filter: ready + current       - Version Filter: ready + current
- Top-60 Dense Candidates               - Top-60 Sparse Candidates
     │                                       │
     └───────────────────┬───────────────────┘
                         ▼
             Reciprocal Rank Fusion (RRF)
                  RRF_Score(d) = Σ [ 1 / (k + rank_i(d)) ]  (default k = 60)
                         │
                         ▼
               Top-20 Fused Candidates
                         │
                         ▼
               Cross-Encoder Reranker
          Scores `(query, chunk.raw_content)` jointly
                         │
                         ▼
                  EvidencePackage
         (Top-5 retrieved/reranked evidence chunks)
                         │
                         ▼
              ADR-0003 Entailment Gate
           (Entailment: Evidence ⊨ Claim)
                         │
                         ▼
                 Verified Response
```

### 13.1 Dual-Engine Complementarity

- **Dense Semantic Retrieval:** Embeds the user query via the embedding provider and calculates cosine distance (`<=>`) against `embeddings.embedding`. Captures conceptual similarity, semantic synonyms, and natural language paraphrasing.
- **Sparse Full-Text Search:** Evaluates the user query via PostgreSQL FTS (`websearch_to_tsquery` matched against `chunks.tsv` using a GIN index). Scored via `ts_rank_cd`. Captures exact keyword hits, alphanumeric identifiers, model names, error strings, and domain-specific acronyms. PostgreSQL native FTS is the approved sparse mechanism.
- **Reciprocal Rank Fusion (RRF):** Merges the two disparate score spaces without requiring fragile score normalization or empirical weight balancing:
  $$\text{RRF\_Score}(d \in D) = \sum_{m \in \{\text{dense}, \text{sparse}\}} \frac{1}{k + \text{Rank}_m(d)}$$
  Where default smoothing constant $k = 60$. If a document appears in only one candidate list, its reciprocal rank for the missing list is treated as 0.
- **Cross-Encoder Reranking:** Top fused candidates (Phase-1 default: 20) are scored by a cross-encoder reranker that evaluates full query-document cross-attention `(query, raw_source_text)`. Reranking eliminates lexical and semantic noise, selecting the highest-precision candidates (Phase-1 default: 5) for inclusion in the `EvidencePackage`.

---

## 14. Retrieval Tenancy & Query Isolation

Retrieval enforces dual-layer defense-in-depth tenancy aligned with ADR-0002 and ADR-0008:

1. **Authoritative Database Boundary:** All retrieval queries execute under PostgreSQL Row-Level Security (`SECURITY INVOKER`). In user-scoped sessions, PostgreSQL enforces that `chunks.workspace_id` belongs to a workspace where `auth.uid()` holds an active record in `workspace_members`.
2. **Application Defense-in-Depth:** Every SQL query generated by `RetrievalModule` explicitly includes:
   ```sql
   WHERE c.workspace_id = :workspaceId
     AND dv.status = 'ready'
     AND dv.is_current = true
   ```
3. **Index Pre-Filtering:** Dense vector retrieval utilizes pre-filtered HNSW indexing on `embeddings.workspace_id` (or partitioned indices) to guarantee that vector distance calculations occur strictly within the tenant boundary, preventing cross-tenant nearest-neighbor graph traversal.
4. **No Post-Fetch Tenancy Filtering:** Post-query application filtering of un-scoped retrieval results is strictly prohibited. All queries must be scoped before index evaluation.

---

## 15. Bounded Fallback & Index Degradation Governance

> [!CAUTION]
> **Unbounded Sequential Vector Scans Prohibited in Production:**
> 
> Executing an un-indexed sequential vector scan (`ORDER BY embedding <=> :query`) across a large multi-tenant table causes severe I/O exhaustion, high CPU utilization, connection pool starvation, and multi-second query latency.
> 
> If the HNSW vector index becomes degraded, corrupted, or unavailable:
> 1. The system must evaluate whether an explicitly bounded fallback is safe and benchmarked.
> 2. The primary approved fallback is **Sparse FTS-Only Retrieval** with clear operational telemetry alerting.
> 3. An explicitly bounded vector fallback (strictly capped by tenant row limits and aggressive statement timeouts) may be used only if empirically benchmarked.
> 4. Under no circumstances may an unbounded sequential scan execute silently in production.

---

## 16. The EvidencePackage & ADR-0003 Truth Boundary

The output of the retrieval pipeline is the `EvidencePackage`:

```typescript
interface EvidencePackage {
  query: string;
  workspace_id: string;
  retrieval_timestamp: string;
  evidence_items: Array<{
    chunk_id: string;
    document_id: string;
    document_version_id: string;
    raw_content: string;               // Exact original extracted source text (NO breadcrumbs)
    provenance: ChunkProvenance;       // Format-agnostic source location tracking
    scores: {
      dense_rank?: number;             // 1-based rank in dense vector candidate list
      sparse_rank?: number;            // 1-based rank in sparse FTS candidate list
      rrf_score: number;               // Fused Reciprocal Rank Fusion score
      rerank_score: number;            // Cross-encoder relevance score
    };
  }>;
}
```

### 16.1 Architectural Domain Separation

- **ADR-0009 Domain (Relevance Discovery):** "What text in the workspace knowledge base is most relevant to the query?" ADR-0009 discovers, fuses, and reranks candidate source evidence. The `EvidencePackage` contains **candidate evidence**, not verified facts.
- **ADR-0003 Domain (Truth Verification):** "Does the acquired evidence logically entail the claims made in the answer?" ADR-0003 consumes the `EvidencePackage` and executes the Two-Stage Cascade Entailment Gate (`Evidence ⊨ Claim`).
- *Retrieval relevance must never be conflated with factual entailment.*

---

## 17. Parameter Governance: Decisions, Defaults & Tunables

To preserve architectural durability, parameters are strictly categorized into immutable architectural decisions, Phase-1 defaults, tunable configurations, and dynamic cost models:

| Category | Parameter | Type | Default Value | Governance / Lifecycle |
| :--- | :--- | :--- | :--- | :--- |
| **Canonical Architecture** | Ingestion Topology | Architectural Invariant | Decoupled Asynchronous Worker | Immutable architectural decision. |
| **Canonical Architecture** | Reliability Model | Architectural Invariant | At-least-once, retryable, single-writer, idempotent | Immutable architectural decision. |
| **Canonical Architecture** | Provenance Quarantine | Architectural Invariant | Breadcrumbs $\in$ Embedding; Raw Text $\in$ Evidence | Immutable architectural decision. |
| **Canonical Architecture** | Visibility Boundary | Architectural Invariant | `status = 'ready' AND is_current = true` | Immutable architectural decision. |
| **Canonical Architecture** | Hybrid Retrieval | Architectural Invariant | Dense (pgvector) + Sparse (PostgreSQL FTS) + RRF + Reranker | Immutable architectural decision. |
| **Phase-1 Default** | Embedding Model | Configurable Default | `text-embedding-3-small` (1536 dimensions) | Tunable via `IEmbeddingProvider` abstraction. |
| **Phase-1 Default** | Tokenizer Base | Configurable Default | `cl100k_base` | Tunable per embedding model family. |
| **Phase-1 Default** | Target Chunk Size | Tunable Parameter | **512 tokens** | Tunable via environment/workspace configuration. |
| **Phase-1 Default** | Chunk Overlap | Tunable Parameter | **64 tokens** | Tunable via environment/workspace configuration. |
| **Phase-1 Default** | Embedding Batch Size | Tunable Parameter | **100 chunks / request** | Tunable based on provider rate limits. |
| **Phase-1 Default** | RRF Constant ($k$) | Tunable Parameter | **60** | Tunable based on retrieval recall benchmarks. |
| **Phase-1 Default** | Candidate Counts | Tunable Parameter | **60 Dense + 60 Sparse $\rightarrow$ 20 RRF $\rightarrow$ 5 Final** | Tunable based on latency/precision requirements. |
| **Phase-1 Default** | Reranker Timeout | Tunable Parameter | **150 ms** | Tunable; falls back to pure RRF ordering on timeout. |
| **Dynamic Cost Model** | Ingestion Cost | Dynamic Formula | $\text{Cost} \propto \sum \text{Tokens} \times \text{Unit Pricing}$ | Dynamic calculation; provider prices are not frozen in ADR. |

---

## 18. Performance Hypotheses & Initial SLO Candidates

Performance figures are **initial operational hypotheses and target SLO candidates**, not rigid architectural promises. They must be validated via empirical benchmarks in the target deployment environment:

- **HTTP Gateway Protection:** Offloading document processing to asynchronous workers removes heavy computation from the synchronous request path and substantially reduces exposure to HTTP gateway timeouts.
- **Ingestion Throughput Hypotheses:**
  - Standard 10-page document ($\approx 4,000$ tokens): Processing completion target $< 5.0\text{ s}$ under normal worker queue load.
  - Large 50-page document ($\approx 20,000$ tokens): Processing completion target $< 25.0\text{ s}$ under normal worker queue load.
- **Retrieval Latency Hypotheses (Target SLO Candidates):**
  - Query Embedding Generation: Target $30\text{ ms} - 50\text{ ms}$.
  - Dual Dense + Sparse Retrieval ($2 \times 60$ candidates): Target $40\text{ ms} - 70\text{ ms}$.
  - Reciprocal Rank Fusion (RRF): Target $< 5\text{ ms}$.
  - Cross-Encoder Reranking (20 candidates): Target $40\text{ ms} - 80\text{ ms}$.
  - End-to-End Retrieval Pipeline (`EvidencePackage` Generation): Target $115\text{ ms} - 205\text{ ms}$.

---

## 19. Failure Modes & Graceful Degradation

| Failure Mode | Detection Point | Architectural Mitigation & Recovery |
| :--- | :--- | :--- |
| **Extraction / Parsing Failure** | Worker extraction stage | Mark version `status = 'failed'`, record structured error in `document_versions.metadata`. Prior active version remains retrievable. |
| **Chunking Failure** | Worker chunking stage | Mark version `status = 'failed'`. Transaction rolls back; no orphan chunks persisted. |
| **Embedding Provider Outage** | Worker embedding stage | Exponential backoff retry (up to max configured attempts). If exhausted, version marked `status = 'failed'`. Prior active version unaffected. |
| **Worker Process Crash** | Physical delivery queue | Unacknowledged job redelivered to available worker. Single-writer lock or conditional update prevents concurrent corruption; retry cleans partial state. |
| **Concurrent Redelivery Race** | Worker entry point | Single-writer concurrency control ensures competing execution waits, retries, or aborts safely. At most one worker mutates state for `document_version_id`. |
| **Reranker Timeout / Failure** | Retrieval reranking stage | Circuit breaker triggers at 150 ms timeout; pipeline gracefully falls back to Top-5 RRF candidate order without failing the user request. |
| **HNSW Index Degradation** | Vector search stage | Evaluates bounded fallback; falls back to Sparse FTS-Only search. Unbounded sequential vector scans are strictly prohibited. |
| **FTS Index Corruption** | Sparse search stage | Falls back to Dense-Only vector retrieval while emitting high-priority administrative alert. |
| **Version Activation Failure** | Activation transaction | If final activation transaction fails, version remains `status = 'processing'` or transitions to `'failed'`. Prior active version remains current. |

---

## 20. Cross-ADR Reconciliation

| Architectural Decision | ADR-0009 Dependency & Relationship | Boundary ADR-0009 Must Respect | Domain Owned by ADR-0009 | Domain NOT Owned by ADR-0009 |
| :--- | :--- | :--- | :--- | :--- |
| **ADR-0001 (Modular Monolith)** | Implemented within NestJS modules. | Clean module boundaries, dependency injection, and shared database connections. | Internal structure of `IngestionModule` and `RetrievalModule`. | Microservice decomposition or HTTP framework choice. |
| **ADR-0002 (Vector Tenancy)** | Extends vector isolation into hybrid retrieval. | Authoritative PostgreSQL RLS boundary; `SECURITY INVOKER`; tenant pre-filtering. | Dual dense/sparse query generation, RRF fusion, and bounded fallback. | RLS policy definitions or vector extension selection. |
| **ADR-0003 (Citation Entailment)** | Provides evidence for downstream entailment. | Preserves unaltered raw source text; synthetic breadcrumbs strictly quarantined. | Evidence candidate discovery, ranking, and `EvidencePackage` construction. | Claim entailment verification and citation verification algorithms. |
| **ADR-0004 (Canonical Memory)** | Documents and memories coexist in workspace. | Memory persists in `memory_entries`; documents persist in `documents`/`chunks`. | Document chunking, versioning, and document retrieval. | Conversational memory hydration, extraction, or memory tenancy. |
| **ADR-0005 (Agent Graph Flow)** | Ingestion and retrieval invoked by agent nodes. | Agent graphs pass server-derived execution context; LLMs hold zero database authority. | Tool execution logic for document search within `RetrievalModule`. | Agent graph topology, supervisor routing, or direct answer guards. |
| **ADR-0006 (API Contract & Streaming)** | Exposes upload and retrieval endpoints. | REST and SSE contracts; Workspace $\rightarrow$ Thread hierarchy. | Ingestion upload handler, version status endpoints, and retrieval payloads. | SSE streaming protocol, thread message schemas, or run lifecycles. |
| **ADR-0007 (Database Schema)** | Persists strictly into 15 canonical entities. | Exactly 15 entities; no new tables; unidirectional document versioning. | Schema mapping for `documents`, `document_versions`, `chunks`, and `embeddings`. | Altering the 15-entity schema or adding background job tables. |
| **ADR-0008 (Identity & Worker Governance)** | Adheres to identity and background worker trust. | No user token replay; least-privileged background execution; no automatic `service_role`. | Structure of `AuthorizedJobEnvelope` payload and ingestion execution logic. | Authentication mechanisms, RBAC policies, or JWT validation. |

---

## 21. Architectural Invariants

The following 20 invariants are absolute and must be enforced by all implementations:

1. **Authoritative Tenancy:** `workspace_id` is the authoritative tenant boundary for all documents, chunks, embeddings, and retrieval queries.
2. **Authoritative Database RLS:** PostgreSQL Row-Level Security is the authoritative database data-access boundary; application-level filters serve strictly as defense-in-depth.
3. **No Un-Scoped Retrieval:** No retrieval query path may bypass workspace tenancy filtering; index searches must be pre-filtered by `workspace_id`.
4. **Least-Privileged Worker:** The ingestion worker does not automatically receive or inherit `service_role` authority merely because it executes asynchronously.
5. **No Token Retention or Replay:** Asynchronous workers must never retain, persist, or replay user Bearer JWTs.
6. **Provenance vs. Authority:** `workspace_id` and `actor_user_id` in the `AuthorizedJobEnvelope` establish execution target scope and audit provenance, not authorization credentials.
7. **At-Least-Once Delivery:** The physical delivery mechanism must provide at-least-once delivery semantics; the system must expect and tolerate duplicate deliveries.
8. **Retryable Execution:** Ingestion execution must be retryable with bounded exponential backoff.
9. **Single-Writer Concurrency Control:** Worker executions for the same `document_version_id` must be serialized; at most one worker may mutate state for a given document version at a time.
10. **Idempotent Effects:** Ingestion writes must be idempotent, clearing partial writes transactionally before rewriting to guarantee deterministic convergence.
11. **15-Entity Schema Preservation:** Ingestion and retrieval operate strictly within ADR-0007's 15 canonical entities; no new database tables (such as `jobs` or `background_jobs`) may be introduced.
12. **Strict Active-Version Retrieval:** Only document versions satisfying `status = 'ready' AND is_current = true` participate in retrieval.
13. **Atomic Version Activation:** The atomic document-version activation transaction is the sole retrieval visibility boundary.
14. **Quarantined Synthetic Breadcrumbs:** Synthetic breadcrumbs used during embedding generation must **never** become citation evidence or pollute `chunks.content`.
15. **EvidencePackage Purity:** The `EvidencePackage` exposes raw extracted source text and format-agnostic provenance; it contains candidate evidence, not verified facts.
16. **ADR-0003 Truth Boundary:** Retrieval performs relevance discovery; ADR-0003 owns the authoritative claim-entailment verification boundary.
17. **Dual-Tenant Hybrid Search:** Both dense vector search and sparse FTS search must be pre-filtered by `workspace_id`.
18. **Unbounded Vector Scans Prohibited:** Unbounded sequential vector scans are strictly prohibited in production; degraded vector retrieval falls back safely to FTS-only or bounded vector searches.
19. **Non-Destructive Reprocessing:** A failed or processing replacement version cannot invalidate or interrupt an existing active document version.
20. **Configurable Tunables:** Chunk sizes, overlap sizes, candidate counts, model names, and timeouts are configurable Phase-1 defaults, not immutable architectural constants.

---

## 22. Security Considerations

- **Cross-Tenant Retrieval Prevention:** Guarded by dual-layer enforcement: PostgreSQL RLS (`SECURITY INVOKER`) enforces tenancy at the SQL layer, while application queries explicitly apply `WHERE workspace_id = :workspaceId`.
- **Malicious Document & Prompt Injection Defenses:** Documents uploaded to workspaces may contain adversarial prompts (indirect prompt injection). Ingestion treats all document content as untrusted data. Chunks are stored as passive strings; extraction parsers must run in sandboxed environments with bounded memory and CPU limits. Document content is never executed as code.
- **Stale Version Leakage:** Version activation is transactional. If a document is updated, the previous version is atomically deactivated (`is_current = false`), preventing race conditions where both versions appear simultaneously in retrieval hits.
- **Unauthorized Worker Execution:** The `AuthorizedJobEnvelope` contains an immutable `claims_snapshot` recorded at the time of upload authorization. Workers only execute allowlisted operations (`'ingest_document_version'`).
- **Poisoned Retrieval Quarantining:** Adversarial content injected into documents cannot bypass the citation guard; ADR-0003 independently evaluates whether the retrieved text logically entails the claim before any answer is returned to the user.

---

## 23. Observability & Telemetry

To monitor pipeline health without introducing unapproved database entities, ingestion and retrieval emit structured telemetry events across standard logging and tracing pipelines (e.g. OpenTelemetry):

- **Ingestion Telemetry Fields:** `job_id`, `correlation_id`, `workspace_id`, `document_id`, `document_version_id`, `worker_attempt`, `stage` (`extract`, `normalize`, `chunk`, `embed`, `index`, `activate`), `extracted_char_count`, `chunk_count`, `token_count`, `embedding_duration_ms`, `total_duration_ms`, `failure_reason`.
- **Retrieval Telemetry Fields:** `correlation_id`, `workspace_id`, `query_length`, `dense_candidate_count`, `sparse_candidate_count`, `fused_candidate_count`, `rerank_duration_ms`, `total_retrieval_duration_ms`, `fallback_state` (`normal`, `fts_only`, `bounded_vector`), `top_rerank_score`.

---

## 24. Implementation Boundaries & Modular Architecture

Aligned with ADR-0001, ingestion and retrieval logic is organized into clean NestJS modules:

- **`IngestionModule`:**
  - `IngestionController`: Validates upload requests, creates `document_versions`, and dispatches `AuthorizedJobEnvelope`.
  - `IJobQueueAdapter`: Abstract interface for job dispatch and consumer subscription (allowing in-process or durable queue implementations).
  - `IngestionWorker`: Consumer handling job execution, single-writer locking, extraction, chunking, and version activation.
  - `DocumentParserRegistry`: Format-specific parsers (`PdfParser`, `DocxParser`, `MarkdownParser`, `PlainTextParser`) producing normalized structural models.
  - `HierarchicalChunkerService`: Executes Structure-Aware Hierarchical Chunking.
  - `IEmbeddingProvider`: Abstract provider for generating dense vector embeddings (`OpenAIEmbeddingProvider`, etc.).
- **`RetrievalModule`:**
  - `HybridRetrievalService`: Coordinates concurrent dense and sparse queries.
  - `DenseSearchService`: Executes pgvector cosine queries with workspace pre-filtering.
  - `SparseSearchService`: Executes PostgreSQL FTS queries with workspace pre-filtering.
  - `ReciprocalRankFusionService`: Executes RRF rank merging.
  - `IRerankerProvider`: Abstract cross-encoder provider for candidate reranking.
  - `EvidencePackageBuilder`: Assembles the final `EvidencePackage` for ADR-0003.

---

## 25. Deferred Decisions

The following implementation-level choices are explicitly deferred and do not alter this architectural decision:
1. **Concrete Queue Technology:** Selection of the concrete physical queue backend (e.g., Redis BullMQ, PostgreSQL transactional job polling, AWS SQS) remains deferred and swappable via `IJobQueueAdapter`.
2. **Worker Deployment Model:** Whether workers execute in the same NestJS process or in separate worker processes remains an operational deployment decision.
3. **Exact Locking Primitive:** The choice between PostgreSQL transaction-scoped advisory locks, row-level conditional locking, or queue partition keys remains an implementation detail.
4. **Alternative Embedding Providers:** Upgrading from `text-embedding-3-small` to alternative models remains configurable via `IEmbeddingProvider`.
5. **Exact Cross-Encoder Model:** The concrete reranker model weights and hosting mechanism remain configurable via `IRerankerProvider`.
6. **Future Multimodal Ingestion:** Image, audio, and video ingestion are deferred to future dedicated architecture records.

---

## 26. Consequences

### 26.1 Positive Consequences
- **Eliminates HTTP Gateway Timeouts:** Moving heavy document extraction, tokenization, and embedding generation to asynchronous workers protects API response times.
- **Superior Contextual Integrity:** Structure-Aware Hierarchical Chunking prevents truncated headings and orphaned code/table blocks.
- **High-Recall & High-Precision Retrieval:** Combining pgvector dense semantic search with PostgreSQL FTS captures both conceptual meaning and exact identifiers, while cross-encoder reranking eliminates false positives.
- **Rock-Solid Provenance:** Strict separation between synthetic breadcrumbs and raw source content protects the integrity of ADR-0003 citation verification.
- **Strict Schema Compliance:** Full adherence to ADR-0007 without adding auxiliary database tables.
- **Fault-Tolerant Continuity:** Processing failures in replacement versions never invalidate active versions.

### 26.2 Negative Consequences & Tradeoffs
- **Operational Complexity:** Asynchronous processing requires managing worker pools, job redeliveries, and single-writer concurrency locks.
- **Two-Engine Retrieval Overhead:** Running dual queries (dense + sparse) increases query orchestration complexity compared to pure vector search.
- **Reranker Latency:** Cross-encoder inference adds 40–80 ms to the retrieval critical path.
- **Parameter Sensitivity:** Optimal chunk sizes, overlap tokens, and RRF smoothing constants require empirical benchmarking per domain.

---

## 27. Non-Goals

ADR-0009 explicitly does **NOT** govern:
- Authentication or user credential verification (owned by ADR-0008).
- Database schema entity definitions or migrations (owned by ADR-0007).
- Memory extraction, hydration, or conversational memory tenancy (owned by ADR-0004).
- Multi-agent graph execution, node routing, or supervisor graphs (owned by ADR-0005).
- SSE streaming protocols or REST API URL routes (owned by ADR-0006).
- Claim-entailment verification algorithms or citation rendering (owned by ADR-0003).

---

## 28. Acceptance Criteria

An implementation complies with ADR-0009 if and only if:

1. **Asynchronous Request Path:** Document upload endpoints accept files, persist `document_versions` in `status = 'processing'`, dispatch an `AuthorizedJobEnvelope`, and return immediately without performing extraction or embedding synchronously.
2. **At-Least-Once & Idempotent Execution:** Duplicate delivery of the same `AuthorizedJobEnvelope` results in deterministic convergence to a single set of chunks and embeddings without duplicate records.
3. **Single-Writer Concurrency:** Concurrent worker executions for the same `document_version_id` are serialized; multiple workers cannot simultaneously mutate chunks or embeddings for the same version.
4. **Non-Destructive Failure:** Ingestion failure updates the target version to `status = 'failed'` and leaves any previously active version (`status = 'ready', is_current = true`) retrievable.
5. **Retrieval Visibility Gate:** Chunks are retrievable if and only if their parent version satisfies `status = 'ready' AND is_current = true`. Activation occurs in a single atomic transaction.
6. **Provenance Quarantine:** Synthetic breadcrumbs are passed exclusively to the embedding provider; `chunks.content` and `EvidencePackage.raw_content` contain exclusively unaltered source text.
7. **Generic Provenance:** Every chunk carries a valid `ChunkProvenance` record with format-appropriate coordinates.
8. **Dual-Engine Tenancy:** Dense vector search and sparse FTS search both enforce `workspace_id` pre-filtering and execute under PostgreSQL RLS.
9. **No Unbounded Scans:** The database query planner never executes an unbounded sequential vector scan when vector indices are degraded; queries fall back safely to FTS-only or bounded execution.
10. **Evidence Hand-off:** The retrieval pipeline outputs a valid `EvidencePackage` to the ADR-0003 Entailment Gate without declaring evidence "verified" prior to entailment evaluation.
11. **Zero Schema Expansion:** The implementation requires zero additional database tables beyond the 15 canonical entities frozen in ADR-0007.

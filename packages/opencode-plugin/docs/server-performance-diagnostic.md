# Memory MCP Server — Performance Diagnostic Report

> **Context**: Plugin-side investigation of slow first-session startup and `project_status` tool timeouts when the MCP server manages a large database.
>
> **Server codebase**: `memory-mcp-1file` (Rust, embedded SurrealDB + candle embeddings)
>
> **Date**: 2026-05-12

---

## Problem Statement

Two user-facing symptoms:

1. **First message of each session is very slow** — the plugin's `chat.message` hook blocks while injecting memory context.
2. **`project_status` tool frequently times out** — the MCP SDK's default 60-second timeout is exceeded.

Both are caused by server-side operations that scale poorly with database size.

---

## Architecture Context

### Plugin → Server Call Pattern (First Message)

On the first message of every session, the plugin fires **5 parallel MCP tool calls**:

```
Promise.all([
  recall(query)             → MCP "recall" (RRF: vector + BM25 + PPR graph)
  listProjectMemories()     → MCP "list_memories" / "get_valid"
  getProjectListInfo()      → MCP "project_info" action:"list"
  detectCommunities()       → MCP "knowledge_graph" action:"detect_communities"
  retrieveLearningRecords() → MCP learning memory read
])
```

All 5 hit the same server process simultaneously. Server limits concurrency with `db_semaphore = Semaphore::new(10)`.

### `project_status` Call Path

```
Plugin tool_registry "project_status" action:"list"
  → callMemoryTool("project_info", { action: "list" })
    → callToolWithRetry() → MCP client.callTool()
      → Server handler: list_projects()
```

Same code path used by `fetchCodeIntelContext()` during first-message injection.

---

## Root Cause #1: `list_projects` — O(5N) Sequential DB Queries

**File**: `server/logic/code/indexing.rs` lines 1633–1760

For each project in the list, the server executes **5 sequential SurrealDB queries**:

```rust
// For EACH project:
storage.get_index_status(project_id)        // query 1
storage.count_chunks(project_id, None)      // query 2
storage.count_symbols(project_id, None)     // query 3
storage.count_embedded_chunks(project_id, None)  // query 4
storage.count_embedded_symbols(project_id, None)  // query 5
```

With N projects, this is **5N sequential round-trips** to SurrealDB. Each query acquires a `db_semaphore` permit.

**Impact**: With 10 projects → 50 sequential DB queries. Under load from 5 parallel tool calls, semaphore contention amplifies latency. Easily exceeds 60s timeout.

### Recommended Fix

**Option A — Single aggregation query** (preferred):

Replace the 5 per-project queries with a single SurrealDB query that aggregates all stats:

```sql
SELECT
  project_id,
  count(IF type = 'chunk' THEN 1 END) as chunk_count,
  count(IF type = 'symbol' THEN 1 END) as symbol_count,
  count(IF type = 'chunk' AND embedded = true THEN 1 END) as embedded_chunk_count,
  count(IF type = 'symbol' AND embedded = true THEN 1 END) as embedded_symbol_count
FROM code_entities
GROUP BY project_id
```

Combined with a single `get_all_index_statuses()` call, this reduces 5N queries to **2 total queries** regardless of N.

**Option B — Parallel per-project queries**:

If aggregation isn't feasible, at minimum use `futures::join_all()` to parallelize the 5 queries per project:

```rust
let stats = futures::future::join_all(
    projects.iter().map(|p| async {
        tokio::join!(
            storage.get_index_status(p.id),
            storage.count_chunks(p.id, None),
            storage.count_symbols(p.id, None),
            storage.count_embedded_chunks(p.id, None),
            storage.count_embedded_symbols(p.id, None),
        )
    })
).await;
```

**Option C — Server-side caching**:

`moka` is already a dependency. Cache `list_projects` result for 30–60 seconds:

```rust
// AppState
project_list_cache: moka::future::Cache<(), ProjectListResponse>

// In list_projects handler:
state.project_list_cache.try_get_with((), async { compute_project_list().await }).await
```

---

## Root Cause #2: `recall` — Multi-Stage Fusion Search

**File**: `server/logic/search.rs` lines 548–780

The `recall` tool executes a 3-stage hybrid search:

1. **Embedding inference** — `state.embedding.embed(&query)` via `spawn_blocking` (candle model). Has LRU cache, but first queries miss cache.
2. **Vector search** — `storage.vector_search()` using SurrealDB HNSW index (`<|K,EF|>` KNN operator). K = min(limit×4, 200), EF = max(K, 150). This is indexed (not brute force).
3. **BM25 search** — `lexical_memory_search()` first calls `storage.list_memories()` to fetch candidate memories, then runs in-memory BM25 engine. The `list_memories` call fetches ALL matching memories from DB to build an allowed-ID set.
4. **PPR graph walk** — `storage.get_subgraph()` → petgraph DiGraph → `run_ppr()` on up to 20 seed nodes.
5. **RRF merge** — reciprocal rank fusion across all 3 result sets.

**Bottleneck**: Step 3 (BM25) involves a full table scan via `list_memories` before the in-memory search engine can run. With large memory databases, this dominates.

### Recommended Fix

- **Pre-built BM25 index**: The BM25 in-memory index is already warmed at startup (`main.rs` L619–640). If `lexical_memory_search` can query the pre-built index directly instead of re-fetching from DB, this eliminates the full scan on every recall.
- **SurrealDB full-text search**: SurrealDB supports native full-text search indexes. Consider replacing the in-memory BM25 engine with a DB-level full-text index to avoid the fetch-all pattern.

---

## Root Cause #3: `detect_communities` — Full Graph Load

**File**: `server/logic/graph.rs` lines 178–233

Loads ALL entities and relations from DB into an in-memory petgraph DiGraph, then runs Leiden community detection. O(E + R) in memory and CPU where E = entities, R = relations.

### Recommended Fix

- Cache community detection results with TTL (e.g. 5 minutes). Community structure changes slowly.
- Consider incremental community detection when graph changes, rather than full recomputation.

---

## Root Cause #4: Embedding Model First-Query Latency

**File**: `embedding/service.rs`, macro `ensure_embedding_ready!`

On first MCP tool call after server start, if the embedding model is still loading, the handler **blocks** (polling every 500ms, up to `model_load_timeout_ms` = 600s default). This is by design for correctness but adds 5–30s to the first `recall` call depending on hardware.

The model is loaded async at startup (`start_loading()` in `main.rs` L497–498), so this only matters if the first tool call arrives before model loading completes.

### Recommended Fix

- **Warmup embedding on startup**: After model loads, run a dummy `embed("warmup")` to prime caches and JIT paths.
- **Report loading status**: Add a `status` tool or health endpoint that reports model loading progress, so the plugin can skip embedding-dependent calls until ready.

---

## Root Cause #5: DB Semaphore Contention

**File**: `main.rs` — `AppState.db_semaphore = Semaphore::new(10)`

All database operations acquire a permit from this semaphore (max 10 concurrent ops). When the plugin fires 5 parallel tool calls and each triggers multiple DB queries, they compete for permits:

- `list_projects` alone: 5N sequential permits
- `recall`: 3+ permits (vector search + list_memories + graph)
- `detect_communities`: 2+ permits (entity list + relation list)

Total demand can easily exceed 10, causing queuing.

### Recommended Fix

- Increase semaphore to 20–32, or make it configurable via environment variable.
- Consider per-operation-type semaphores (separate limits for reads vs. writes).

---

## Root Cause #6: BM25 Warm-up Blocks Startup

**File**: `main.rs` lines 619–640

At startup, the server eagerly loads ALL code chunks and ALL memories into in-memory BM25 indexes via paginated streaming. With large databases, this takes significant time and delays server readiness.

### Recommended Fix

- Make BM25 warmup lazy (build index on first search) or async (don't block server start).
- Persist BM25 index to disk and load incrementally.

---

## Summary: Priority Matrix

| Issue | Impact | Effort | Priority |
|---|---|---|---|
| `list_projects` 5N sequential queries | **Critical** — direct timeout cause | Medium (query refactor) | **P0** |
| BM25 full table scan in `recall` | High — slowest stage of recall | Medium (use pre-built index) | **P1** |
| DB semaphore too low (10) | High — amplifies all above | Low (config change) | **P1** |
| Community detection full graph load | Medium — one of 5 parallel calls | Low (add moka cache) | **P2** |
| Embedding first-query latency | Medium — one-time per startup | Low (warmup probe) | **P2** |
| BM25 warmup blocks startup | Low–Medium — one-time | Medium (lazy/async) | **P3** |

---

## Appendix: How to Reproduce

1. Use a memory database with 500+ memories and 5+ code-indexed projects.
2. Start a new session (stdio mode).
3. Send any message — observe first-message injection latency.
4. Invoke `project_status` tool — observe timeout.

### Observability

The server logs timing information. Key log patterns to grep:

- `list_projects` duration
- `recall` stage timings (vector/bm25/ppr)
- `db_semaphore` wait times (if instrumented)
- `ensure_embedding_ready` wait time

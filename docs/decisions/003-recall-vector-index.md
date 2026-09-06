---
title: "ADR-003: Optional sqlite-vec projection for hybrid recall"
status: accepted
decision_id: ADR-003
created: 2026-07-30
amended: 2026-09-06
scope: embedding_items, sqlite-vec, hybrid recall
supersedes: []
related:
  - ./001-storage-truth-boundary.md
  - ./008-recall-fts-tokenizer.md
  - ./006-project-first-runtime-home.md
---

# ADR-003: Optional sqlite-vec projection for hybrid recall

## 状态

**Accepted — implemented as an optional, default-off projection**

## Decision

SHIFT keeps Memory, messages, invocation events, and project documents in their
existing authoritative tables. Semantic search uses a rebuildable
`embedding_items` projection plus one `sqlite-vec` `vec0` table per model
generation and dimension.

Embedding is disabled by default. When enabled, the server:

1. loads `sqlite-vec`;
2. creates or opens the active generation;
3. records eligible projection tasks in the same SQLite transaction as the
   authoritative write and FTS projection;
4. generates vectors asynchronously with leases and bounded retries;
5. applies thread/project partitions before KNN candidate generation;
6. combines exact, FTS, and vector ranks using RRF;
7. falls back to exact/FTS results on every vector-side failure.

The initial providers use an OpenAI-compatible `/embeddings` HTTP contract.
Both `local` and `openai-compatible` configuration modes use that contract; a
local service normally omits the bearer token.

## Constraints

- A vec0 integer primary key is bound as `BigInt` with
  `better-sqlite3`/`sqlite-vec` 0.1.9.
- Dimensions never mix in a vec0 table.
- Model generations are not silently switched over an existing active index.
- Agent tool input cannot select scopes, models, generations, channel weights,
  or hybrid mode.
- Superseded or invalidated Memory is filtered against the authoritative table,
  even if an older vector remains in the rebuildable projection.
- Query embeddings and vector writes never make recall unavailable; FTS remains
  the operational fallback.

## Operations

Configuration:

```text
SHIFT_EMBEDDING_ENABLED=true
SHIFT_EMBEDDING_PROVIDER=openai-compatible
SHIFT_EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1
SHIFT_EMBEDDING_MODEL=...
SHIFT_EMBEDDING_DIMENSIONS=...
SHIFT_EMBEDDING_API_KEY=...
```

Backfill active Memory and eligible L0/project passages against the online
database (`SHIFT_HOME/data/shift.sqlite`, or an explicit `--db`):

```text
npm run backfill:embeddings -- --db "$SHIFT_HOME/data/shift.sqlite"
```

Limit a resumable run to selected layers with `--kinds`, for example
`--kinds memory,message`. Re-running is idempotent for unchanged content.

## Consequences

Semantic retrieval can improve paraphrase recall without changing Memory write
or lifecycle semantics. The cost is an optional native extension, an embedding
endpoint, a background worker, and a rebuildable projection that must be
monitored independently from authoritative storage.

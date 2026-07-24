---
title: SHIFT Memory Data Contract
status: approved-with-foundation-blockers
version: 1.0
created: 2026-07-24
scope: PR-0 Foundation and later memory PRs
---

# SHIFT Memory Data Contract v1.0

**Status:** `Approved with Foundation blockers`  
**Meaning:** Architecture direction is frozen. PR-0 may start only after implementing the four blockers in this document as **decisions**, not as mid-flight improvisation.

This contract is the single source of truth for memory ownership, schema, purge/archive, projection, failure semantics, and authority. Implementation PRs must not invent alternate meanings.

---

## 0. Non-goals for PR-0

PR-0 **does**:

- schema rebuild + ownership
- project identity resolution + thread freeze
- archive vs purge
- purge ledger + source_deleted resolution
- recall projection ownership for project memory
- supersession transaction order + dual-connection concurrency policy
- availability tri-state (available / degraded / unavailable)
- server-side derivation of authority / activation (no client forge)
- legacy capture_key backfill

PR-0 **does not**:

- enable cross-thread Active Memory injection as product default (that is PR-2)
- auto extraction / suggestions pipeline (PR-3/4)
- project evidence passage index (PR-5)
- embeddings (PR-6)

Fixtures may write `scope=project` to prove ownership and search survival after purge.

---

## 1. Approved principles (unchanged)

1. SQLite is the only online store. No external memory SaaS.
2. Evidence (L0) is truth. Summaries and Active Memory Cards are navigation.
3. Institutional memory may be project-scoped; process noise stays thread-scoped.
4. Search / recent / related are the three recall entrances (behavior expands after Foundation).
5. Suggestions are not facts until user accept.
6. Injected ≠ used. Telemetry must separate the two.
7. Embedding is optional and gated by evaluation, not by default.

---

## 2. Blocker 1 — `memory_entries` table rebuild (mandatory)

### 2.1 Why ALTER is insufficient

SQLite cannot change via ordinary `ALTER TABLE`:

- `thread_id TEXT NOT NULL`
- `ON DELETE CASCADE`
- existing `CHECK` and FK semantics

Current foundation (v1): `memory_entries.thread_id NOT NULL` + `REFERENCES threads(id) ON DELETE CASCADE`.

Therefore **M2 = full table rebuild**.

### 2.2 Rebuild procedure (migration must follow)

```text
BEGIN;
  -- Use migration framework safe boundary.
  -- Prefer: foreign_keys OFF only for the rebuild section if required by SQLite rebuild patterns.
  PRAGMA foreign_keys = OFF;

  CREATE TABLE memory_entries_vNext ( ... target schema ... );

  INSERT INTO memory_entries_vNext (...)
  SELECT ... mapped columns from memory_entries ...;

  DROP TABLE memory_entries;
  ALTER TABLE memory_entries_vNext RENAME TO memory_entries;

  -- recreate indexes (active uniqueness, capture keys, list indexes)
  -- rebind / rebuild recall projection for memories (see §3)

  PRAGMA foreign_key_check;
  -- integrity_check may run outside the transaction if migration runner requires it
COMMIT;
PRAGMA foreign_keys = ON;
PRAGMA integrity_check;
```

Post-migration audit:

- every project row has `project_key IS NOT NULL` and `owner_thread_id IS NULL`
- every thread row has `owner_thread_id IS NOT NULL` and `project_key IS NULL`
- no project row retains a non-null `owner_thread_id` that could CASCADE-delete the row
- `foreign_key_check` empty
- `integrity_check` = `ok`
- recall audit: each active memory has a searchable projection (see §3)

### 2.3 Target columns (no ambiguous `thread_id`)

**Do not keep a long-lived ambiguous `thread_id`.**

| Column | Role | Nullability |
|--------|------|-------------|
| `owner_thread_id` | Thread-scope **owner** | required when `scope=thread`; **NULL** when `scope=project` |
| `project_key` | Project-scope **owner** | required when `scope=project`; **NULL** when `scope=thread` |
| `origin_thread_id` | Provenance only | always nullable; `ON DELETE SET NULL` |

Owner CHECK (database-enforced):

```sql
CHECK (
  (scope = 'thread'  AND owner_thread_id IS NOT NULL AND project_key IS NULL)
  OR
  (scope = 'project' AND project_key IS NOT NULL AND owner_thread_id IS NULL)
)
```

FK intent:

```text
owner_thread_id  → threads(id) ON DELETE CASCADE   -- only thread-owned rows die with thread
origin_thread_id → threads(id) ON DELETE SET NULL  -- provenance never owns the row
project_key      → projects(project_key) ON DELETE RESTRICT
```

### 2.4 Target `memory_entries` schema (normative)

```sql
CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY,

  scope TEXT NOT NULL CHECK (scope IN ('thread', 'project')),

  owner_thread_id TEXT,
  project_key TEXT,
  origin_thread_id TEXT,

  kind TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('captured', 'confirmed', 'superseded', 'invalidated')),

  -- Who is responsible for the current conclusion (see §6)
  authority TEXT NOT NULL
    CHECK (authority IN ('system', 'user', 'agent')),

  -- How it participates in inject/search. v1: no 'scoped' (see §7)
  activation TEXT NOT NULL
    CHECK (activation IN ('always_on', 'query', 'backstop')),

  content TEXT NOT NULL,
  summary TEXT,
  topic TEXT,
  supersession_key TEXT,
  capture_key TEXT NOT NULL,

  content_hash TEXT,
  anchors_json TEXT,
  metadata_json TEXT,

  -- Provenance of text / creation path (not the same as authority)
  created_by TEXT NOT NULL,
  confirmed_by TEXT,
  created_at TEXT NOT NULL,
  verified_at TEXT,
  superseded_by TEXT,

  CHECK (
    (scope = 'thread'  AND owner_thread_id IS NOT NULL AND project_key IS NULL)
    OR
    (scope = 'project' AND project_key IS NOT NULL AND owner_thread_id IS NULL)
  ),

  FOREIGN KEY (owner_thread_id) REFERENCES threads(id) ON DELETE CASCADE,
  FOREIGN KEY (origin_thread_id) REFERENCES threads(id) ON DELETE SET NULL,
  FOREIGN KEY (project_key) REFERENCES projects(project_key) ON DELETE RESTRICT,
  FOREIGN KEY (superseded_by) REFERENCES memory_entries(id) ON DELETE SET NULL
);
```

Indexes:

```sql
CREATE UNIQUE INDEX memory_active_thread_supersession
  ON memory_entries(owner_thread_id, supersession_key)
  WHERE scope = 'thread'
    AND supersession_key IS NOT NULL
    AND status IN ('captured', 'confirmed');

CREATE UNIQUE INDEX memory_active_project_supersession
  ON memory_entries(project_key, supersession_key)
  WHERE scope = 'project'
    AND supersession_key IS NOT NULL
    AND status IN ('captured', 'confirmed');

CREATE UNIQUE INDEX memory_capture_thread
  ON memory_entries(owner_thread_id, capture_key)
  WHERE scope = 'thread';

CREATE UNIQUE INDEX memory_capture_project
  ON memory_entries(project_key, capture_key)
  WHERE scope = 'project';

CREATE INDEX memory_project_active
  ON memory_entries(project_key, status, kind, created_at)
  WHERE scope = 'project' AND status IN ('captured', 'confirmed');

CREATE INDEX memory_thread_active
  ON memory_entries(owner_thread_id, status, kind, created_at)
  WHERE scope = 'thread' AND status IN ('captured', 'confirmed');
```

### 2.5 Legacy row mapping (rebuild SELECT)

All existing rows migrate as **thread scope** (safe default; no silent project promotion):

```text
scope            = 'thread'
owner_thread_id  = old.thread_id
project_key      = NULL
origin_thread_id = old.thread_id
authority        = derive from created_by / metadata (default 'agent'; system bootstrap 'system'; UI 'user' if known)
activation       = 'query' for product kinds; 'backstop' for handoff/window-seal
capture_key      = COALESCE(old.capture_key, 'legacy:' || old.id)
topic            = parse from supersession_key or metadata.topic
confirmed_by     = metadata.confirmedBy if status was confirmed, else NULL
```

### 2.6 Legacy `capture_key` backfill

Old schema allows `capture_key` NULL. Target is `NOT NULL`.

Rule:

```text
capture_key = existing non-empty capture_key
           OR ('legacy:' || memory.id)
```

New write paths always generate non-null capture keys. Never insert NULL.

---

## 3. Blocker 2 — Recall / FTS projection ownership

### 3.1 Problem

Today memory FTS projection sets `recall_items.thread_id = memory.threadId` with `recall_items.thread_id NOT NULL` + `ON DELETE CASCADE`.

After project memory survives thread purge, **search projection still dies** → project memory becomes unsearchable. This is a Foundation bug if deferred to PR-2.

### 3.2 Decision (v1): dual-track projection

**Chosen approach:** keep `recall_items` for message/event evidence; give **L2 memory its own FTS** owned by memory scope.

| Layer | Storage | Owner key |
|-------|---------|-----------|
| L2 memory search | `memory_fts` (content=`memory_entries`) or dedicated projection table without thread CASCADE | `scope` + `owner_thread_id` / `project_key` |
| L0 message / event search | `recall_items` (+ existing FTS) | `thread_id` (thread-owned evidence) |

Rationale:

- avoids making all recall_items project-aware in one step
- prevents project memory search from depending on origin thread lifetime
- keeps message/event purge semantics simple (thread purge removes thread evidence search)

### 3.3 Minimum schema for memory search (Foundation)

Option A (preferred if FTS content tables work cleanly with rebuild):

```sql
CREATE VIRTUAL TABLE memory_fts USING fts5(
  topic,
  content,
  summary,
  content='memory_entries',
  content_rowid='rowid'  -- requires INTEGER PK or map table; see Option B if TEXT PK
);
```

Because `memory_entries.id` is TEXT PK, **Option B is the default practical path**:

```sql
CREATE TABLE memory_search (
  memory_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  owner_thread_id TEXT,
  project_key TEXT,
  origin_thread_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT,
  FOREIGN KEY (memory_id) REFERENCES memory_entries(id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE memory_search_fts USING fts5(
  title,
  content,
  content='memory_search',
  content_rowid='rowid'
);
-- triggers AI/AD/AU as with recall_items
```

Ownership rules for `memory_search`:

```text
scope=thread  → owner_thread_id set; project_key NULL
scope=project → project_key set; owner_thread_id NULL
origin_thread_id is provenance only; never the CASCADE owner of the search row
```

`memory_search` must **not** FK-own via `threads` with CASCADE on origin.

### 3.4 Index / reindex API

On every memory create/transition:

1. upsert `memory_entries`
2. upsert `memory_search` from the same row
3. FTS triggers keep `memory_search_fts` in sync

On rebuild migration: backfill `memory_search` for all memories.

Search path changes (can land in PR-0 as internal API, public cross-thread UX in PR-2):

- memory layer queries `memory_search` / `memory_search_fts` with owner predicates
- message/evidence layers keep `recall_items`

### 3.5 Purge survival requirement

Given project memory M created from thread A:

1. purge A  
2. M still in `memory_entries`  
3. M still in `memory_search`  
4. FTS still returns M for query on content/topic  
5. `origin_thread_id` is NULL; anchors resolve per §4

---

## 4. Blocker 3 — Purge ledger and `source_deleted` vs `source_missing`

### 4.1 Problem

If purge only nulls `origin_thread_id` and deletes messages/invocations, remaining anchors are bare missing IDs. Cannot distinguish:

| Case | Needed label |
|------|----------------|
| Evidence existed, user purged thread | `source_deleted` |
| Anchor never valid / wrong id | `source_missing` |
| Transient store lag / corruption | not silently labeled deleted |

### 4.2 `purged_threads` ledger (required)

```sql
CREATE TABLE purged_threads (
  thread_id TEXT PRIMARY KEY,
  former_project_key TEXT,
  former_project_canonical_path TEXT,
  purged_at TEXT NOT NULL,
  purged_by TEXT,
  reason TEXT,
  metadata_json TEXT
);
```

On **purge** (not archive):

1. insert ledger row (idempotent on thread_id)
2. delete thread-owned L0 + thread-scoped memories (CASCADE via owner_thread_id)
3. set `origin_thread_id = NULL` on surviving project memories
4. update their `memory_search.origin_thread_id = NULL`
5. hard-delete thread row (or keep tombstone thread — v1: hard-delete after ledger write is OK)

Archive does **not** write purge ledger.

### 4.3 Anchor capture shape (message / invocation)

When writing anchors at capture time, freeze:

```json
{
  "type": "invocation",
  "ref": "inv-...",
  "originThreadId": "thread-...",
  "capturedProjectKey": "wt:abc..." 
}
```

Same for `message`. File anchors remain project-relative; also store `capturedProjectKey` when available.

### 4.4 Resolution algorithm

```text
resolveAnchor(anchor):
  if entity exists → ok (drill-down)
  if entity missing:
    threadHint = anchor.originThreadId OR memory.origin_thread_id (if still set)
    if threadHint && exists purged_threads(threadHint) → source_deleted
    else → source_missing
```

UI / inject must show explicit badge; never pretend drill-down works.

### 4.5 Why ledger is not optional

Without ledger, null origin + missing entity is ambiguous forever.  
Ledger is small, append-mostly, and Foundation-owned.

---

## 5. Blocker 4 — Thread projectDir change vs L0 identity history

### 5.1 Problem

L0 evidence is keyed by `thread_id` only. If a live thread switches `projectDir` from A to B:

- old messages were produced under A
- thread's current `project_key` becomes B
- later project filters/promotion/anchor checks can mis-attribute history to B

### 5.2 v1 decision (frozen): **lock after first L0 write**

**Recommended and required for v1:**

```text
IF thread has any messages OR invocations OR thread-scoped memories OR recall rows:
  reject projectDir change with 409
  message: create a new thread for the new project
ELSE:
  allow identity re-resolve and overwrite thread project_* fields
```

Optional later (not PR-0): `captured_project_key` on every message/invocation for multi-era threads.

### 5.3 Thread identity fields (still required)

On create / allowed update:

```text
project_key
project_canonical_path
project_identity_kind   -- none | directory | git-worktree
project_identity_json   -- full resolution snapshot
```

Empty projectDir → `kind=none`, all project_* NULL, product writes forced to `scope=thread`.

### 5.4 Worktree identity (frozen)

v1: **isolate by worktree root** (`git-worktree`), not common git dir.  
Sharing across worktrees is opt-in future work.

---

## 6. Authority, provenance, confirmation (frozen choice)

### 6.1 Three distinct fields

| Field | Meaning |
|-------|---------|
| `created_by` | Who produced the text / write path (`user`, `agent:codex`, `extractor:v1`, `system:...`) |
| `authority` | Who is **responsible for the current conclusion** for ranking: `system` \| `user` \| `agent` |
| `confirmed_by` | Who confirmed (`user` when status becomes confirmed via user action); nullable |
| `status` | Lifecycle: `captured` \| `confirmed` \| `superseded` \| `invalidated` |

### 6.2 Suggestion promotion (frozen)

When user accepts a suggestion:

```text
created_by     = extractor:<version>   (or agent:... if agent-drafted)
authority      = user                  // user owns the conclusion
status         = confirmed
confirmed_by   = user
verified_at    = now
activation     = query (unless system path)
```

**Rejected alternative:** keep `authority=agent` after user confirm.  
Reason: ranking should treat user-accepted institutional memory as user-responsible.

### 6.3 Direct writes

| Entry | created_by | authority | status |
|-------|------------|-----------|--------|
| UI user create | `user` | `user` | `captured` (or `confirmed` if UI "confirm on write") |
| Agent upsert / ```memory | `agent:<id>` | `agent` | `captured` |
| User later confirms agent memory | unchanged created_by | **`user`** | `confirmed`, `confirmed_by=user` |
| System iron rules | `system:...` | `system` | `confirmed`, activation `always_on` |

User confirm of agent text **raises authority to user** (same rule as suggestion accept). Provenance stays in `created_by` + anchors.

---

## 7. Activation (v1 narrowed)

### 7.1 Enum v1

```text
always_on | query | backstop
```

**`scoped` is not in v1.**  
Reason: ownership already uses `scope=thread|project`; activation `scoped` without `activation_filter_json` is undefined behavior.

When PR-3+ implements filters:

```json
{
  "topics": [],
  "paths": [],
  "agents": [],
  "operations": []
}
```

…then `scoped` may be reintroduced with executable matching.

### 7.2 Defaults by kind

| kind | default activation |
|------|--------------------|
| decision / constraint / fact / lesson | `query` |
| handoff / window-seal / digest | `backstop` |
| system iron rules only | `always_on` |

### 7.3 Server-side derivation (no client forge)

Clients **must not** successfully set arbitrary:

```json
{ "authority": "system", "activation": "always_on" }
```

| Writer | Max authority | Max activation |
|--------|---------------|----------------|
| Agent callback / ```memory | `agent` | `query` (backstop only for auto kinds) |
| UI user | `user` | `query` (user may not set always_on in v1) |
| System bootstrap / migration / built-in seed | `system` | `always_on` |
| Extractor | cannot write `memory_entries` | suggestions only |

Service maps trusted `writeChannel` → fields. Ignore or strip client-supplied authority/activation outside allowlist.

### 7.4 always_on budget

Always-on segment has **independent char budget** (e.g. 800–1200).  
It cannot consume the entire card; query-matched and thread segments retain reserved space.

---

## 8. Default scope by kind (frozen)

| kind | default scope | inject gate |
|------|---------------|-------------|
| decision | project if identity ≠ none else thread | active statuses |
| constraint | project if identity ≠ none else thread | active statuses |
| lesson | project if identity ≠ none else thread | **confirmed only** |
| fact | **thread** (explicit project opt-in) | active statuses |
| handoff / window-seal / digest | thread | backstop + caps |

---

## 9. Supersession transaction + concurrency

### 9.1 Order inside one transaction

```text
1. resolve owner keys (scope, owner_thread_id / project_key)
2. capture_key hit → return existing
3. load active peers for supersession_key under same owner
4. mark peers superseded with superseded_by = NULL
5. insert new row
6. backfill peers.superseded_by = new.id
7. upsert memory_search projection
commit
```

Never insert a second active row before retiring peers (UNIQUE will fire).

### 9.2 Dual-connection concurrency (required tests)

`better-sqlite3` single connection is serial; tests **must** use:

- two independent DB connections (or processes)
- WAL mode + busy_timeout
- concurrent `createProduct` on same `(project_key, supersession_key)`

**Conflict policy (frozen):**

```text
On SQLITE_CONSTRAINT / unique active conflict:
  service performs bounded retry (e.g. 3):
    re-read active peers
    re-run supersession transaction
  if still failing → surface error to caller (500/409 with retryable=true)
Unique index remains the last line of defense.
```

DoD is not only “one active at end” but **documented retry semantics**.

---

## 10. Archive vs purge (frozen)

| Operation | UI default | Thread row | L0 evidence | Thread memory | Project memory | Purge ledger |
|-----------|------------|------------|-------------|---------------|----------------|--------------|
| archive | yes | `deleted_at` set; hidden | kept | kept | kept | no |
| purge | explicit confirm | removed | deleted | deleted | kept; origin nulled | **yes** |

Default “delete session” = **archive**.  
Hard `DELETE FROM threads` without ledger is forbidden for product API after PR-0.

---

## 11. Availability tri-state (frozen)

```text
available     — query succeeded; empty flag independent
degraded      — partial success; show warning + partial items
unavailable   — memory state unknown; NEVER render “尚无结构化记忆”
```

Propagate on: retrieveForTurn stats, bootstrap inject, SSE, Memory UI, search API.

---

## 12. Project identity (`resolveProjectIdentity`)

```text
empty projectDir     → { kind: 'none' }  // force thread scope
non-git directory    → normalize path → project_key = 'dir:' + sha256(canonical)[0:32]
git worktree         → worktree root  → project_key = 'wt:'  + sha256(canonical)[0:32]
```

Always persist **canonical_path** alongside key.  
Never merge empty dirs into one project.  
Windows: lowercase drive, `/` separators, trim trailing slash (except root), prefer realpath when available.

---

## 13. Anchors contract

```json
{
  "type": "file|commit|message|invocation|url",
  "ref": "...",
  "revision": null,
  "line": null,
  "endLine": null,
  "originThreadId": null,
  "capturedProjectKey": null,
  "label": null
}
```

File refs: project-relative only; reject `..` and absolute paths.  
Resolution: §4.4.

---

## 14. Suggestions table (schema frozen for PR-3; not required filled in PR-0)

```sql
CREATE TABLE memory_suggestions (
  id TEXT PRIMARY KEY,
  project_key TEXT,
  origin_thread_id TEXT,
  proposed_kind TEXT NOT NULL,
  proposed_scope TEXT NOT NULL,
  topic TEXT,
  summary TEXT,
  content TEXT NOT NULL,
  confidence REAL,
  anchors_json TEXT NOT NULL,
  extractor_version TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')),
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  promoted_memory_id TEXT,
  metadata_json TEXT
);
```

PR-0 may create the empty table or defer DDL to PR-3; if deferred, document in migration plan. **Promotion rules are already frozen in §6.2.**

---

## 15. PR sequence (frozen)

| PR | Name |
|----|------|
| **PR-0** | Foundation: rebuild, projection, purge ledger, project lock, availability, supersession, authz derivation |
| **PR-1** | Telemetry events + budgets + degraded UX polish |
| **PR-2** | Cross-thread inject/search product behavior |
| **PR-3** | Suggestions + governance fields usage |
| **PR-4** | Digest + extractor (suggestions only) |
| **PR-5** | Project evidence passages |
| **PR-6** | Embedding if eval fails FTS on synonym/cross-lingual cases |

---

## 16. Foundation (PR-0) Definition of Done

### Ownership & rebuild

- [ ] `memory_entries` rebuilt; no project row owned by Thread CASCADE
- [ ] owner CHECK enforced
- [ ] no ambiguous long-lived `thread_id` column
- [ ] legacy NULL `capture_key` migrates via `legacy:<id>`
- [ ] `PRAGMA foreign_key_check` clean; `integrity_check` ok
- [ ] recall/memory search audit passes after migration

### Projection

- [ ] project memory FTS/search projection not CASCADE-owned by origin thread
- [ ] after thread purge, project memory still searchable

### Purge / source resolution

- [ ] `purged_threads` ledger written on purge
- [ ] `source_deleted` vs `source_missing` distinguishable in tests
- [ ] archive does not write purge ledger and does not destroy L0

### Project identity

- [ ] `resolveProjectIdentity` + fields frozen on thread
- [ ] empty projectDir never shares a project_key
- [ ] worktree root ≠ main repo path when distinct
- [ ] projectDir change rejected once L0 exists (409)

### Writes / authz / concurrency

- [ ] callback cannot forge `authority=system` or `activation=always_on`
- [ ] supersession order retire → insert → backfill
- [ ] dual-connection concurrent write has bounded retry + unique fallback
- [ ] activation enum is only `always_on|query|backstop`

### Failure semantics

- [ ] SQLite failures surface `unavailable`/`degraded`, never false empty copy

### Explicit non-goals still true

- [ ] product cross-thread inject default remains off until PR-2
- [ ] no automatic extractor → active memory

---

## 17. Product decisions (final)

1. **Scope defaults:** decision/constraint → project; fact → thread; lesson → project but inject only when confirmed; empty identity → all thread.
2. **lesson kind:** yes, structured minimum (坑/根因/防护/锚点).
3. **Promotion:** user-only accept; `authority=user` with full extractor/agent provenance in `created_by`.
4. **Embedding:** feature-flagged; enable only after offline recall@K gap attributed mainly to synonym/cross-lingual miss.

---

## 18. Sign-off line

```text
Status: Approved with Foundation blockers
Blockers addressed in this revision:
  (1) memory_entries SQLite table rebuild + owner columns
  (2) memory search projection ownership (not thread CASCADE)
  (3) purged_threads ledger + source_deleted resolution
  (4) projectDir lock after L0 / no silent evidence re-attribution
Ready for: PR-0 implementation
```

When PR-0 merges with §16 DoD checked, status may flip to `Foundation complete`; PR-2 may enable cross-thread product behavior.

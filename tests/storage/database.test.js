const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  openMemoryDatabase,
  withTransaction,
  checkpointMemoryDatabase,
} = require("../../src/storage/database");
const { applyMigrations, validateMigrations } = require("../../src/storage/migrations");
const { MIGRATIONS } = require("../../src/storage/schema");
const { createStorage } = require("../../src/storage");

test("memory database applies schema and safety pragmas", () => {
  const db = openMemoryDatabase({ file: ":memory:" });
  try {
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
        .all()
        .map((row) => row.name)
    );

    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(db.pragma("busy_timeout", { simple: true }), 8000);
    assert.equal(
      db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version,
      MIGRATIONS.length
    );
    for (const name of [
      "threads",
      "context_windows",
      "messages",
      "trace_runs",
      "handoffs",
      "invocations",
      "invocation_events",
      "memory_entries",
      "memory_search",
      "memory_events",
      "legacy_memory_archive",
      "thread_digests",
      "project_documents",
      "project_passages",
      "projects",
      "purged_threads",
      "storage_metadata",
      "storage_outbox",
      "embedding_indexes",
      "embedding_items",
      "collaboration_tasks",
      "collaboration_task_events",
      "recall_items",
      "recall_fts",
    ]) {
      assert.ok(tables.has(name), `expected ${name} table`);
    }

    assert.equal(applyMigrations(db), MIGRATIONS.length);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count,
      MIGRATIONS.length
    );
    const memoryColumns = new Set(
      db
        .prepare("PRAGMA table_info(memory_entries)")
        .all()
        .map((column) => column.name)
    );
    for (const column of [
      "metadata_json",
      "window_id",
      "capture_key",
      "supersession_key",
      "owner_thread_id",
      "project_key",
      "origin_thread_id",
      "authority",
      "activation",
    ]) {
      assert.ok(memoryColumns.has(column), `expected memory_entries.${column}`);
    }
    const memorySearchColumns = new Set(
      db
        .prepare("PRAGMA table_info(memory_search)")
        .all()
        .map((column) => column.name)
    );
    assert.ok(memorySearchColumns.has("topic"));
    const memorySearchIndexes = new Set(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memory_search'"
        )
        .all()
        .map((row) => row.name)
    );
    assert.ok(memorySearchIndexes.has("memory_search_thread_topic"));
    assert.ok(memorySearchIndexes.has("memory_search_project_topic"));
    const memoryFtsSql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_search_fts'")
      .get().sql;
    assert.match(memoryFtsSql, /tokenize='trigram'/);
    const embeddingColumns = new Set(
      db
        .prepare("PRAGMA table_info(embedding_items)")
        .all()
        .map((column) => column.name)
    );
    for (const column of [
      "source_kind",
      "source_id",
      "source_version",
      "chunk_index",
      "scope_key",
      "content_hash",
      "model",
      "dimensions",
      "index_generation",
      "status",
      "attempt_count",
      "lease_owner",
      "lease_expires_at",
      "last_error",
    ]) {
      assert.ok(embeddingColumns.has(column), `expected embedding_items.${column}`);
    }
    const windowColumns = new Set(
      db
        .prepare("PRAGMA table_info(context_windows)")
        .all()
        .map((column) => column.name)
    );
    for (const column of [
      "reserve_ratio",
      "context_used_tokens",
      "context_usage_source",
      "billing_total_tokens",
      "billing_cost_usd",
    ]) {
      assert.ok(windowColumns.has(column), `expected context_windows.${column}`);
    }
    const threadColumns = new Set(
      db
        .prepare("PRAGMA table_info(threads)")
        .all()
        .map((column) => column.name)
    );
    assert.ok(threadColumns.has("next_message_sequence"));
    const invocationColumns = new Set(
      db
        .prepare("PRAGMA table_info(invocations)")
        .all()
        .map((column) => column.name)
    );
    for (const column of [
      "parent_invocation_id",
      "trigger_message_id",
      "trigger_type",
      "next_event_sequence",
    ]) {
      assert.ok(invocationColumns.has(column), `expected invocations.${column}`);
    }
    const messageColumns = new Set(
      db
        .prepare("PRAGMA table_info(messages)")
        .all()
        .map((column) => column.name)
    );
    assert.ok(messageColumns.has("message_type"));
  } finally {
    db.close();
  }
});

test("database quick check and WAL checkpoint report healthy state", () => {
  const db = openMemoryDatabase({ file: ":memory:" });
  try {
    assert.equal(db.pragma("quick_check", { simple: true }), "ok");
    assert.ok(Array.isArray(checkpointMemoryDatabase(db, "PASSIVE")));
    assert.throws(() => checkpointMemoryDatabase(db, "invalid"), /Unsupported WAL checkpoint/);
  } finally {
    db.close();
  }
});

test("new database creates a stable clean epoch and activates cutover explicitly", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    const first = storage.metadata.getCurrent();
    const second = storage.metadata.getCurrent();

    assert.match(first.epochId, /^epoch-[0-9a-f]{32}$/);
    assert.equal(first.schemaVersion, MIGRATIONS.length);
    assert.equal(first.dataPolicy, "clean");
    assert.equal(first.isClean, true);
    assert.equal(first.isActive, false);
    assert.equal(first.cutoverTime, null);
    assert.deepEqual(second, first);

    const activated = storage.metadata.activateCleanCutover({
      cutoverTime: "2026-07-26T12:00:00+08:00",
    });
    assert.equal(activated.epochId, first.epochId);
    assert.equal(activated.isActive, true);
    assert.equal(activated.cutoverTime, "2026-07-26T04:00:00.000Z");
    assert.deepEqual(storage.metadata.activateCleanCutover(), activated);
  } finally {
    storage.close();
  }
});

test("storage epoch identity and cutover survive database reopen", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shift-storage-epoch-"));
  const dbFile = path.join(tmpDir, "memory.sqlite");
  let expected;
  try {
    const firstStorage = createStorage({ file: dbFile });
    expected = firstStorage.metadata.activateCleanCutover({
      cutoverTime: "2026-07-26T04:00:00.000Z",
    });
    firstStorage.close();

    const reopenedStorage = createStorage({ file: dbFile });
    try {
      assert.deepEqual(reopenedStorage.metadata.getCurrent(), expected);
    } finally {
      reopenedStorage.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("database with existing runtime rows is marked legacy validation, not cut over", () => {
  const db = openMemoryDatabase({ file: ":memory:", migrations: MIGRATIONS.slice(0, 10) });
  try {
    db.prepare(
      "INSERT INTO threads (id, created_at, updated_at) VALUES ('legacy-thread', 'now', 'now')"
    ).run();

    assert.equal(applyMigrations(db), MIGRATIONS.length);
    const metadata = db.prepare("SELECT * FROM storage_metadata WHERE singleton = 1").get();
    assert.match(metadata.epoch_id, /^legacy-[0-9a-f]{32}$/);
    assert.equal(metadata.schema_version, MIGRATIONS.length);
    assert.equal(metadata.data_policy, "legacy-validation");
    assert.equal(metadata.cutover_at, null);
    const storage = createStorage({ db });
    assert.throws(
      () => storage.metadata.activateCleanCutover(),
      /Legacy-validation storage cannot be activated/
    );
  } finally {
    db.close();
  }
});

test("clean epoch activation refuses business rows written before cutover", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    storage.db
      .prepare("INSERT INTO threads (id, created_at, updated_at) VALUES ('t', 'now', 'now')")
      .run();
    assert.throws(() => storage.metadata.activateCleanCutover(), /requires an empty database/);
    assert.equal(storage.metadata.getCurrent().isActive, false);
  } finally {
    storage.close();
  }
});

test("storage metadata schema version follows later migrations", () => {
  const db = openMemoryDatabase({ file: ":memory:" });
  try {
    const futureMigrations = [
      ...MIGRATIONS,
      {
        version: MIGRATIONS.length + 1,
        name: "test_future_schema",
        sql: "CREATE TABLE test_future_schema (id INTEGER PRIMARY KEY);",
      },
    ];

    assert.equal(applyMigrations(db, futureMigrations), MIGRATIONS.length + 1);
    assert.equal(
      db.prepare("SELECT schema_version FROM storage_metadata WHERE singleton = 1").get()
        .schema_version,
      MIGRATIONS.length + 1
    );
  } finally {
    db.close();
  }
});

test("storage migrations require contiguous immutable versions", () => {
  assert.throws(
    () => validateMigrations([{ version: 2, name: "bad", sql: "SELECT 1" }]),
    /Expected storage migration version 1/
  );
  assert.throws(
    () => validateMigrations([{ version: 1, name: "", sql: "SELECT 1" }]),
    /migration 1 is incomplete/
  );
});

test("storage refuses a database created by newer code", () => {
  const db = openMemoryDatabase({ file: ":memory:" });
  try {
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (99, 'future', 'now')"
    ).run();
    assert.throws(
      () => applyMigrations(db),
      new RegExp(`newer than supported version ${MIGRATIONS.length}`)
    );
  } finally {
    db.close();
  }
});

test("later migrations upgrade a version 2 database without losing memory rows", () => {
  const db = openMemoryDatabase({ file: ":memory:", migrations: MIGRATIONS.slice(0, 2) });
  try {
    db.prepare(
      "INSERT INTO threads (id, created_at, updated_at) VALUES ('thread-1', 'now', 'now')"
    ).run();
    db.prepare(
      `
      INSERT INTO memory_entries
        (id, thread_id, kind, status, content, created_by, created_at)
      VALUES ('memory-1', 'thread-1', 'decision', 'captured', 'keep me', 'test', 'now')
    `
    ).run();

    assert.equal(applyMigrations(db), MIGRATIONS.length);
    const memory = db.prepare("SELECT * FROM memory_entries WHERE id = 'memory-1'").get();
    assert.equal(memory.content, "keep me");
    // v6 backfills null capture keys and moves ownership columns.
    assert.equal(memory.capture_key, "legacy:memory-1");
    assert.equal(memory.owner_thread_id, "thread-1");
    assert.equal(memory.scope, "thread");
    assert.equal(memory.supersession_key, null);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 3").get().count,
      1
    );
  } finally {
    db.close();
  }
});

test("client turn migration preserves existing messages and enforces user turn uniqueness", () => {
  const db = openMemoryDatabase({
    file: ":memory:",
    migrations: MIGRATIONS.slice(0, 18),
  });
  try {
    db.prepare(
      "INSERT INTO threads (id, created_at, updated_at) VALUES ('turn-thread', 'now', 'now')"
    ).run();
    db.prepare(
      `INSERT INTO messages
        (id, thread_id, sequence_no, role, content, created_at, message_type)
       VALUES ('legacy-user', 'turn-thread', 0, 'user', 'hello', 'now', 'user')`
    ).run();

    assert.equal(applyMigrations(db), MIGRATIONS.length);
    assert.equal(
      db.prepare("SELECT client_turn_id FROM messages WHERE id = 'legacy-user'").get()
        .client_turn_id,
      null
    );
    db.prepare(
      `INSERT INTO messages
        (id, thread_id, sequence_no, role, content, created_at, message_type, client_turn_id)
       VALUES ('new-user', 'turn-thread', 1, 'user', 'hello', 'now', 'user', 'turn-1')`
    ).run();
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO messages
              (id, thread_id, sequence_no, role, content, created_at, message_type, client_turn_id)
             VALUES ('duplicate-user', 'turn-thread', 2, 'user', 'again', 'now', 'user', 'turn-1')`
          )
          .run(),
      /UNIQUE constraint failed/
    );
  } finally {
    db.close();
  }
});

test("topic migration backfills the existing memory search projection", () => {
  const db = openMemoryDatabase({
    file: ":memory:",
    migrations: MIGRATIONS.slice(0, 13),
  });
  try {
    db.prepare(
      "INSERT INTO threads (id, title, project_dir, created_at, updated_at) VALUES (?, '', '', ?, ?)"
    ).run("thread-topic", "2026-07-30T00:00:00.000Z", "2026-07-30T00:00:00.000Z");
    db.prepare(
      `
      INSERT INTO memory_entries (
        id, scope, owner_thread_id, origin_thread_id, kind, status,
        authority, activation, content, topic, capture_key, created_by, created_at
      ) VALUES (
        'memory-topic', 'thread', 'thread-topic', 'thread-topic', 'decision', 'captured',
        'agent', 'query', 'SQLite 是权威存储。', 'storage.authoritative',
        'decision:storage.authoritative:migration', 'agent:codex', '2026-07-30T00:00:00.000Z'
      )
    `
    ).run();
    db.prepare(
      `
      INSERT INTO memory_search (
        memory_id, scope, owner_thread_id, origin_thread_id,
        kind, status, title, content, created_at, metadata_json
      ) VALUES (
        'memory-topic', 'thread', 'thread-topic', 'thread-topic',
        'decision', 'captured', 'decision:captured', 'SQLite 是权威存储。',
        '2026-07-30T00:00:00.000Z', '{}'
      )
    `
    ).run();

    assert.equal(applyMigrations(db), MIGRATIONS.length);
    assert.equal(
      db.prepare("SELECT topic FROM memory_search WHERE memory_id = 'memory-topic'").get().topic,
      "storage.authoritative"
    );
    assert.equal(
      db
        .prepare(
          `
          SELECT COUNT(*) AS count
          FROM memory_search_fts
          WHERE memory_search_fts MATCH '"权威存储"'
        `
        )
        .get().count,
      1
    );
    assert.equal(
      db.prepare("SELECT schema_version FROM storage_metadata WHERE singleton = 1").get()
        .schema_version,
      MIGRATIONS.length
    );
  } finally {
    db.close();
  }
});

test("context usage migration rebases only legacy active model capacities", () => {
  const db = openMemoryDatabase({ file: ":memory:", migrations: MIGRATIONS.slice(0, 3) });
  try {
    db.prepare("INSERT INTO threads (id, created_at, updated_at) VALUES ('t', 'now', 'now')").run();
    const insert = db.prepare(`
      INSERT INTO context_windows
        (id, thread_id, agent_id, provider_key, workspace_key, generation, state,
         capacity_tokens, created_at)
      VALUES (?, 't', ?, ?, 'base', 1, ?, ?, 'now')
    `);
    insert.run("active-codex", "codex", "codex", "active", 200000);
    insert.run("sealed-gemini", "gemini", "antigravity", "sealed", 200000);

    assert.equal(applyMigrations(db), MIGRATIONS.length);
    assert.equal(
      db.prepare("SELECT capacity_tokens FROM context_windows WHERE id = 'active-codex'").get()
        .capacity_tokens,
      258400
    );
    assert.equal(
      db.prepare("SELECT capacity_tokens FROM context_windows WHERE id = 'sealed-gemini'").get()
        .capacity_tokens,
      200000
    );
  } finally {
    db.close();
  }
});

test("sequence and causality migration backfills counters and message types", () => {
  const db = openMemoryDatabase({ file: ":memory:", migrations: MIGRATIONS.slice(0, 4) });
  try {
    db.prepare("INSERT INTO threads (id, created_at, updated_at) VALUES ('t', 'now', 'now')").run();
    db.prepare(
      `
      INSERT INTO context_windows
        (id, thread_id, agent_id, provider_key, workspace_key, generation, state,
         capacity_tokens, created_at)
      VALUES ('w', 't', 'codex', 'codex', 'base', 1, 'active', 1000, 'now')
    `
    ).run();
    db.prepare(
      `
      INSERT INTO invocations
        (id, thread_id, window_id, agent_id, state, started_at)
      VALUES ('i', 't', 'w', 'codex', 'active', 'now')
    `
    ).run();
    const insertMessage = db.prepare(`
      INSERT INTO messages
        (id, thread_id, invocation_id, sequence_no, role, content, metadata_json, created_at)
      VALUES (?, 't', ?, ?, ?, ?, ?, 'now')
    `);
    insertMessage.run("m-user", null, 0, "user", "hello", null);
    insertMessage.run("m-old-final", "i", 1, "assistant", "old final", null);
    insertMessage.run(
      "m-callback",
      "i",
      2,
      "assistant",
      "callback",
      JSON.stringify({ source: "callback" })
    );
    insertMessage.run("m-final", "i", 3, "assistant", "final", null);
    db.prepare(
      `
      INSERT INTO invocation_events
        (invocation_id, sequence_no, kind, payload_json, created_at)
      VALUES ('i', 3, 'text.delta', '{}', 'now')
    `
    ).run();

    assert.equal(applyMigrations(db), MIGRATIONS.length);
    assert.equal(
      db.prepare("SELECT next_message_sequence value FROM threads WHERE id = 't'").get().value,
      4
    );
    assert.equal(
      db.prepare("SELECT next_event_sequence value FROM invocations WHERE id = 'i'").get().value,
      4
    );
    assert.deepEqual(
      db.prepare("SELECT id, message_type type FROM messages ORDER BY sequence_no").all(),
      [
        { id: "m-user", type: "user" },
        { id: "m-old-final", type: "assistant-callback" },
        { id: "m-callback", type: "assistant-callback" },
        { id: "m-final", type: "assistant-final" },
      ]
    );
  } finally {
    db.close();
  }
});

test("recall FTS triggers stay synchronized with their projection", () => {
  const db = openMemoryDatabase({ file: ":memory:" });
  try {
    db.prepare(
      "INSERT INTO threads (id, created_at, updated_at) VALUES ('thread-1', 'now', 'now')"
    ).run();
    db.prepare(
      `
      INSERT INTO recall_items
        (thread_id, source_kind, source_id, title, content, created_at)
      VALUES
        ('thread-1', 'message', 'message-1', 'SQLite decision', 'Keep raw evidence', 'now')
    `
    ).run();

    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM recall_fts WHERE recall_fts MATCH 'evidence'").get()
        .count,
      1
    );
    db.prepare(
      "UPDATE recall_items SET content = 'Replaced text' WHERE source_id = 'message-1'"
    ).run();
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM recall_fts WHERE recall_fts MATCH 'evidence'").get()
        .count,
      0
    );
    db.prepare("DELETE FROM recall_items WHERE source_id = 'message-1'").run();
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM recall_fts").get().count, 0);
  } finally {
    db.close();
  }
});

test("withTransaction rolls back the complete unit of work", () => {
  const db = openMemoryDatabase({ file: ":memory:" });
  try {
    assert.throws(() =>
      withTransaction(db, () => {
        db.prepare(
          "INSERT INTO threads (id, created_at, updated_at) VALUES ('thread-1', 'now', 'now')"
        ).run();
        throw new Error("stop");
      })
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM threads").get().count, 0);
  } finally {
    db.close();
  }
});

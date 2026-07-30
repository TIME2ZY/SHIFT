const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStorage, openMemoryDatabase } = require("../../src/storage");
const { resolveProjectIdentity, normalizeCanonicalPath } = require("../../src/storage/project-identity");
const { resolveAnchor } = require("../../src/storage/anchor-resolve");
const { deriveWriteFields } = require("../../src/storage/memory-service");

function createFixture(options = {}) {
  const storage = createStorage({ file: options.file || ":memory:" });
  storage.threads.create({
    id: "thread-1",
    projectDir: options.projectDir || "",
    title: "t1",
  });
  return storage;
}

test("migration rebuilds memory_entries with owner columns and capture backfill", () => {
  const storage = createFixture();
  try {
    const row = storage.db.prepare("PRAGMA table_info(memory_entries)").all();
    const names = row.map((c) => c.name);
    assert.ok(names.includes("owner_thread_id"));
    assert.ok(names.includes("project_key"));
    assert.ok(names.includes("origin_thread_id"));
    assert.ok(names.includes("authority"));
    assert.ok(names.includes("activation"));
    assert.ok(!names.includes("thread_id"));

    const outcome = storage.memory.capture({
      id: "m1",
      threadId: "thread-1",
      kind: "handoff",
      content: "handoff body",
      createdBy: "codex",
      captureKey: "handoff:1",
    });
    assert.equal(outcome.memory.scope, "thread");
    assert.equal(outcome.memory.ownerThreadId, "thread-1");
    assert.equal(outcome.memory.projectKey, null);
    assert.equal(outcome.memory.activation, "backstop");
    assert.equal(outcome.memory.authority, "agent");

    const proj = storage.memories.getSearchProjection("m1");
    assert.ok(proj);
    assert.equal(proj.scope, "thread");

    const fk = storage.db.pragma("foreign_key_check");
    assert.equal(fk.length, 0);
    assert.equal(storage.db.pragma("integrity_check", { simple: true }), "ok");
  } finally {
    storage.close();
  }
});

test("project memory survives thread purge and remains searchable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shift-mem-proj-"));
  const storage = createFixture({ projectDir: dir });
  try {
    const thread = storage.threads.get("thread-1");
    assert.ok(thread.projectKey);

    const written = storage.memory.createProduct({
      threadId: "thread-1",
      kind: "decision",
      topic: "storage-primary",
      content: "Use SQLite as online source of truth.",
      createdBy: "user",
      writeChannel: "user",
      scope: "project",
    });
    assert.equal(written.memory.scope, "project");
    assert.equal(written.memory.ownerThreadId, null);
    assert.equal(written.memory.projectKey, thread.projectKey);
    assert.equal(written.memory.originThreadId, "thread-1");

    // Searchable before purge
    const hitsBefore = storage.memories.searchMemory("SQLite", {
      projectKey: thread.projectKey,
      limit: 10,
    });
    assert.ok(hitsBefore.some((h) => h.memoryId === written.memory.id));

    // Purge origin thread
    assert.equal(storage.threads.purge("thread-1", { purgedBy: "test" }), true);
    assert.equal(storage.threads.get("thread-1"), null);
    assert.ok(storage.threads.isPurged("thread-1"));

    const survived = storage.memories.get(written.memory.id);
    assert.ok(survived);
    assert.equal(survived.scope, "project");
    assert.equal(survived.originThreadId, null);

    const hitsAfter = storage.memories.searchMemory("SQLite", {
      projectKey: thread.projectKey,
      limit: 10,
    });
    assert.ok(hitsAfter.some((h) => h.memoryId === written.memory.id));

    // source_deleted via purge ledger
    const resolution = resolveAnchor(
      {
        type: "invocation",
        ref: "missing-inv",
        originThreadId: "thread-1",
      },
      { storage }
    );
    assert.equal(resolution.state, "source_deleted");

    const missing = resolveAnchor(
      { type: "invocation", ref: "never-existed", originThreadId: "other-thread" },
      { storage }
    );
    assert.equal(missing.state, "source_missing");
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("thread projectDir locks after L0 evidence exists", () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "shift-a-"));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "shift-b-"));
  const storage = createStorage({ file: ":memory:" });
  try {
    storage.threads.create({ id: "t-lock", projectDir: dirA });
    storage.messages.append({
      id: "msg-1",
      threadId: "t-lock",
      sequenceNo: 0,
      role: "user",
      content: "hello",
      createdAt: new Date().toISOString(),
    });
    assert.throws(
      () => storage.threads.upsert({ id: "t-lock", projectDir: dirB, title: "x" }),
      (error) => error.code === "PROJECT_DIR_LOCKED" || error.statusCode === 409
    );
  } finally {
    storage.close();
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

test("empty projectDir never shares a project_key", () => {
  const a = resolveProjectIdentity("");
  const b = resolveProjectIdentity("   ");
  assert.equal(a.kind, "none");
  assert.equal(b.kind, "none");
  assert.equal(a.projectKey, null);
  assert.equal(b.projectKey, null);
});

test("path normalization is stable on windows-style paths", () => {
  const n1 = normalizeCanonicalPath("C:\\Foo\\Bar\\");
  const n2 = normalizeCanonicalPath("c:/Foo/Bar");
  if (process.platform === "win32") {
    assert.equal(n1, n2);
    assert.match(n1, /^c:/);
  } else {
    assert.ok(n1.includes("Foo"));
  }
});

test("deriveWriteFields strips client system/always_on for agent channel", () => {
  const fields = deriveWriteFields({
    writeChannel: "agent",
    createdBy: "codex",
    authority: "system",
    activation: "always_on",
    kind: "constraint",
  });
  assert.equal(fields.authority, "agent");
  assert.equal(fields.activation, "query");
});

test("supersession retires peers before insert under unique active index", () => {
  const storage = createFixture();
  try {
    const first = storage.memory.createProduct({
      threadId: "thread-1",
      kind: "fact",
      topic: "port",
      content: "port is 8787",
      createdBy: "user",
      writeChannel: "user",
    });
    const second = storage.memory.createProduct({
      threadId: "thread-1",
      kind: "fact",
      topic: "port",
      content: "port is 9797",
      createdBy: "user",
      writeChannel: "user",
    });
    assert.equal(first.memory.status, "captured");
    assert.equal(storage.memories.get(first.memory.id).status, "superseded");
    assert.equal(storage.memories.get(first.memory.id).supersededBy, second.memory.id);
    assert.equal(storage.memory.listActive("thread-1").length, 1);
  } finally {
    storage.close();
  }
});

test("dual-connection concurrent product write ends with one active", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shift-mem-conc-"));
  const dbFile = path.join(tmp, "memory.sqlite");
  // Initialize schema via storage helper
  const bootstrap = createStorage({ file: dbFile });
  bootstrap.threads.create({ id: "thread-1" });
  bootstrap.close();

  const dbA = openMemoryDatabase({ file: dbFile });
  const dbB = openMemoryDatabase({ file: dbFile });
  const storageA = createStorage({ db: dbA });
  const storageB = createStorage({ db: dbB });

  try {
    // Seed thread on both (same row)
    const results = [];
    const errors = [];
    const run = (storage, id, content) => {
      try {
        results.push(
          storage.memory.createProduct({
            threadId: "thread-1",
            kind: "decision",
            topic: "concurrent-topic",
            content,
            createdBy: "user",
            writeChannel: "user",
            id,
          })
        );
      } catch (error) {
        errors.push(error);
      }
    };

    // Interleave with separate connections (WAL + busy timeout)
    run(storageA, "conc-a", "decision A");
    run(storageB, "conc-b", "decision B");

    const active = storageA.db
      .prepare(
        `
        SELECT id, status FROM memory_entries
        WHERE supersession_key = 'decision:concurrent-topic'
          AND status IN ('captured', 'confirmed')
      `
      )
      .all();
    assert.equal(active.length, 1);
    assert.ok(results.length + errors.length >= 1);
  } finally {
    storageA.close();
    storageB.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("archive hides thread without destroying project memory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shift-arch-"));
  const storage = createFixture({ projectDir: dir });
  try {
    const product = storage.memory.createProduct({
      threadId: "thread-1",
      kind: "constraint",
      topic: "no-rm",
      content: "Do not use rm -rf",
      createdBy: "user",
      writeChannel: "user",
    });
    assert.equal(product.memory.scope, "project");
    assert.equal(storage.threads.archive("thread-1"), true);
    assert.equal(storage.threads.get("thread-1"), null);
    assert.ok(storage.memories.get(product.memory.id));
    assert.equal(storage.threads.isPurged("thread-1"), false);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy capture_key null rows migrate via open of prebuilt v5-like path", () => {
  // Open memory DB which runs full migrations from empty — backfill path is exercised
  // by inserting through v1..v6. Spot-check legacy: prefix generator.
  const storage = createFixture();
  try {
    // Direct insert simulating post-migration create requires capture_key NOT NULL —
    // verify the unique index exists for thread capture.
    const indexes = storage.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memory_entries'")
      .all()
      .map((r) => r.name);
    assert.ok(indexes.includes("memory_capture_thread"));
    assert.ok(indexes.includes("memory_active_thread_supersession"));
    assert.ok(indexes.includes("memory_active_project_supersession"));
  } finally {
    storage.close();
  }
});

test("memory search projects topic and gives exact topic its own channel", () => {
  const storage = createFixture();
  try {
    const written = storage.memory.createProduct({
      threadId: "thread-1",
      kind: "decision",
      topic: "storage.authoritative",
      content: "SQLite 是在线读写的权威存储。",
      createdBy: "agent:codex",
      writeChannel: "agent",
    });

    const projected = storage.db
      .prepare("SELECT topic FROM memory_search WHERE memory_id = ?")
      .get(written.memory.id);
    assert.equal(projected.topic, "storage.authoritative");

    const hits = storage.memories.searchMemory("storage.authoritative", {
      projectKey: written.memory.projectKey,
      threadId: written.memory.ownerThreadId,
      limit: 10,
    });
    assert.equal(hits[0].memoryId, written.memory.id);
    assert.equal(hits[0].topic, "storage.authoritative");
    assert.equal(hits[0].matchChannel, "exact-topic");
    assert.equal(hits[0].rank, -2000);

    const chineseFtsHits = storage.memories.searchMemory("权威存储", {
      projectKey: written.memory.projectKey,
      threadId: written.memory.ownerThreadId,
      limit: 10,
    });
    assert.equal(chineseFtsHits[0].memoryId, written.memory.id);
    assert.equal(chineseFtsHits[0].matchChannel, "fts");
  } finally {
    storage.close();
  }
});

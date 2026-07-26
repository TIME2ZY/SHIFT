const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStorage, openMemoryDatabase } = require("../../src/storage");
const { prepareCleanEpoch } = require("../../src/storage/clean-epoch");
const { MIGRATIONS } = require("../../src/storage/schema");
const { createServerStorage, resolveBoolean } = require("../../src/storage/server-storage");

test("audit transcript boolean accepts explicit and environment-style values", () => {
  assert.equal(resolveBoolean(undefined, "off", true), false);
  assert.equal(resolveBoolean(undefined, "ON", false), true);
  assert.equal(resolveBoolean(false, "on", true), false);
  assert.equal(resolveBoolean(undefined, "unknown", true), true);
});

test("files storage mode does not open SQLite", () => {
  const context = createServerStorage({ storageMode: "files" }, "sessions.json");
  assert.equal(context.mode, "files");
  assert.equal(context.storage, null);
  assert.equal(context.recorder.enabled, false);
  context.close();
});

test("default storage mode uses an activated SQLite database beside a custom sessions file", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-storage-"));
  const databaseFile = path.join(tmpDir, "shift.sqlite");
  prepareCleanEpoch({ file: databaseFile });
  const context = createServerStorage({}, path.join(tmpDir, "sessions.json"));
  try {
    assert.equal(context.mode, "sqlite");
    assert.equal(context.recorder.enabled, true);
    assert.equal(fs.existsSync(databaseFile), true);
  } finally {
    context.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sqlite storage mode opens the durable database", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-storage-sqlite-"));
  const databaseFile = path.join(tmpDir, "shift.sqlite");
  prepareCleanEpoch({ file: databaseFile });
  const context = createServerStorage(
    { storageMode: "sqlite", memoryDbFile: databaseFile },
    path.join(tmpDir, "sessions.json")
  );
  try {
    assert.equal(context.mode, "sqlite");
    assert.equal(context.recorder.enabled, true);
    assert.ok(context.storage);
    assert.ok(context.eventStore);
    assert.equal(context.eventStore.writeSqlite, true);
    assert.equal(context.eventStore.writeTranscript, false);
    assert.ok(context.sessionService);
  } finally {
    context.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sqlite audit transcript switch disables outbox archive independently", () => {
  const storage = createStorage({ file: ":memory:" });
  storage.metadata.activateCleanCutover();
  const context = createServerStorage({
    storageMode: "sqlite",
    storage,
    auditTranscript: false,
    transcript: {
      appendCanonicalEvent() {
        throw new Error("disabled archive must not run");
      },
    },
  });
  try {
    assert.equal(context.mode, "sqlite");
    assert.equal(context.auditTranscript, false);
    assert.equal(context.outboxFlusher, null);
    assert.equal(context.outboxHealth().state, "disabled");
    assert.equal(context.eventStore.archiveCanonical, false);
  } finally {
    context.close();
    storage.close();
  }
});

test("sqlite outbox writes canonical events only to the dedicated audit sink", async () => {
  const storage = createStorage({ file: ":memory:" });
  storage.metadata.activateCleanCutover();
  storage.threads.create({ id: "thread-1" });
  const window = storage.windows.create({
    id: "window-1",
    threadId: "thread-1",
    agentId: "codex",
    providerKey: "codex",
    workspaceKey: "base",
    generation: 1,
    capacityTokens: 1000,
  });
  storage.invocations.start({
    id: "invocation-1",
    threadId: "thread-1",
    windowId: window.id,
    agentId: "codex",
  });
  storage.outbox.enqueue({
    threadId: "thread-1",
    invocationId: "invocation-1",
    sequenceNo: 0,
    kind: "text.delta",
    payload: { text: "canonical" },
    createdAt: new Date().toISOString(),
  });
  const legacyWrites = [];
  const auditWrites = [];
  const context = createServerStorage({
    storageMode: "sqlite",
    storage,
    transcript: {
      appendCanonicalEvent(event) {
        legacyWrites.push(event.id);
      },
    },
    auditTranscriptSink: {
      appendCanonicalEvent(event) {
        auditWrites.push(event.id);
      },
    },
  });
  try {
    await context.outboxFlusher.flushOnce();
    assert.deepEqual(legacyWrites, []);
    assert.equal(auditWrites.length, 1);
  } finally {
    context.close();
    storage.close();
  }
});

test("sqlite canonical archive is namespaced by the active storage epoch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-audit-epoch-"));
  const databaseFile = path.join(root, "shift.sqlite");
  const auditRoot = path.join(root, "audit-transcripts");
  prepareCleanEpoch({ file: databaseFile });
  const context = createServerStorage({
    storageMode: "sqlite",
    memoryDbFile: databaseFile,
    auditTranscriptDir: auditRoot,
    outboxIntervalMs: 60_000,
  });
  try {
    const epoch = context.storage.metadata.getCurrent();
    assert.equal(context.auditTranscriptDir, path.join(auditRoot, epoch.epochId));
  } finally {
    context.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("disabling new audit writes still drains previously committed outbox rows", async () => {
  const storage = createStorage({ file: ":memory:" });
  storage.metadata.activateCleanCutover();
  storage.threads.create({ id: "thread-1" });
  const window = storage.windows.create({
    id: "window-1",
    threadId: "thread-1",
    agentId: "codex",
    providerKey: "codex",
    workspaceKey: "base",
    generation: 1,
    capacityTokens: 1000,
  });
  storage.invocations.start({
    id: "invocation-1",
    threadId: "thread-1",
    windowId: window.id,
    agentId: "codex",
  });
  storage.outbox.enqueue({
    threadId: "thread-1",
    invocationId: "invocation-1",
    sequenceNo: 0,
    kind: "text.delta",
    payload: { text: "already committed" },
    createdAt: new Date().toISOString(),
  });
  const delivered = [];
  const context = createServerStorage({
    storageMode: "sqlite",
    storage,
    auditTranscript: false,
    transcript: {
      appendCanonicalEvent(event) {
        delivered.push(event.id);
      },
    },
  });
  try {
    assert.equal(context.outboxHealth().state, "degraded");
    await context.outboxFlusher.flushOnce();
    assert.equal(delivered.length, 1);
    assert.equal(context.outboxHealth().state, "disabled");
  } finally {
    context.close();
    storage.close();
  }
});

test("dual storage fails open when SQLite initialization fails", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-storage-failure-"));
  const errors = [];
  const context = createServerStorage(
    { storageMode: "dual", memoryDbFile: tmpDir },
    path.join(tmpDir, "sessions.json"),
    { error: (message) => errors.push(message) }
  );
  try {
    assert.equal(context.storage, null);
    assert.equal(context.recorder.enabled, false);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /initialization failed/);
  } finally {
    context.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sqlite storage mode fails hard when SQLite initialization fails", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-storage-sqlite-fail-"));
  assert.throws(
    () =>
      createServerStorage(
        { storageMode: "sqlite", memoryDbFile: tmpDir },
        path.join(tmpDir, "sessions.json"),
        { error() {} }
      ),
    /SHIFT_STORAGE_MODE=sqlite requires a working database/
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("sqlite mode refuses a missing, inactive, or legacy-validation database", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-storage-epoch-gate-"));
  const missing = path.join(tmpDir, "missing.sqlite");
  assert.throws(
    () => createServerStorage({ storageMode: "sqlite", memoryDbFile: missing }),
    /active clean epoch database does not exist/
  );
  assert.equal(fs.existsSync(missing), false);

  const inactive = createStorage({ file: ":memory:" });
  try {
    assert.throws(
      () => createServerStorage({ storageMode: "sqlite", storage: inactive }),
      /requires an active clean epoch/
    );
  } finally {
    inactive.close();
  }

  const legacyFile = path.join(tmpDir, "legacy.sqlite");
  const legacy = openMemoryDatabase({ file: legacyFile, migrations: MIGRATIONS.slice(0, 10) });
  legacy
    .prepare("INSERT INTO threads (id, created_at, updated_at) VALUES (?, ?, ?)")
    .run("legacy-thread", "2026-07-26T00:00:00.000Z", "2026-07-26T00:00:00.000Z");
  legacy.close();
  assert.throws(
    () => createServerStorage({ storageMode: "sqlite", memoryDbFile: legacyFile }),
    /policy=legacy-validation/
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

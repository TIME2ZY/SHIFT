const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStorage, openMemoryDatabase } = require("../../src/storage");
const { prepareCleanEpoch } = require("../../src/storage/offline/clean-epoch");
const { MIGRATIONS } = require("../../src/storage/schema");
const {
  createServerStorage,
  resolveBoolean,
  resolveEpochAuditDirectory,
  safeEpochDirectory,
} = require("../../src/storage/server-storage");

test("audit transcript boolean accepts explicit and environment-style values", async () => {
  assert.equal(resolveBoolean(undefined, "off", true), false);
  assert.equal(resolveBoolean(undefined, "ON", false), true);
  assert.equal(resolveBoolean(false, "on", true), false);
  assert.equal(resolveBoolean(undefined, "unknown", true), true);
});

test("epoch audit directory rejects dot segments and remains inside its root", async () => {
  const root = path.resolve("audit-transcripts");
  assert.throws(() => safeEpochDirectory("."), /Unsafe storage epoch id/);
  assert.throws(() => safeEpochDirectory(".."), /Unsafe storage epoch id/);
  assert.throws(() => safeEpochDirectory("../escape"), /Unsafe storage epoch id/);
  assert.equal(resolveEpochAuditDirectory(root, "epoch-safe_1"), path.join(root, "epoch-safe_1"));
});

test("online storage rejects retired files and dual modes", async () => {
  assert.throws(() => createServerStorage({ storageMode: "files" }), /only accepts sqlite/);
  assert.throws(() => createServerStorage({ storageMode: "dual" }), /only accepts sqlite/);
});

test("default storage mode uses the explicitly resolved runtime database", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-storage-"));
  const databaseFile = path.join(tmpDir, "shift.sqlite");
  prepareCleanEpoch({ file: databaseFile });
  const context = createServerStorage({ memoryDbFile: databaseFile });
  try {
    assert.equal(context.mode, "sqlite");
    assert.equal(context.recorder.enabled, true);
    assert.equal(fs.existsSync(databaseFile), true);
  } finally {
    await context.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sqlite storage mode opens the durable database", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-storage-sqlite-"));
  const databaseFile = path.join(tmpDir, "shift.sqlite");
  prepareCleanEpoch({ file: databaseFile });
  const context = createServerStorage({ storageMode: "sqlite", memoryDbFile: databaseFile });
  try {
    assert.equal(context.mode, "sqlite");
    assert.equal(context.recorder.enabled, true);
    assert.ok(context.storage);
    assert.ok(context.eventStore);
    assert.ok(context.sessionService);
  } finally {
    await context.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("server restart closes active invocation, pending handoff, and active trace", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-storage-reconcile-"));
  const databaseFile = path.join(tmpDir, "shift.sqlite");
  prepareCleanEpoch({ file: databaseFile });
  const crashed = createStorage({ file: databaseFile });
  crashed.threads.upsert({ id: "thread-1", title: "Restart", projectDir: "C:/repo" });
  const window = crashed.windows.create({
    id: "window-1",
    threadId: "thread-1",
    agentId: "codex",
    providerKey: "codex:gpt",
    workspaceKey: "base:C:/repo",
    generation: 1,
    capacityTokens: 1000,
  });
  crashed.traces.start({ id: "trace-1", threadId: "thread-1" });
  crashed.invocations.start({
    id: "source-1",
    threadId: "thread-1",
    traceId: "trace-1",
    windowId: window.id,
    agentId: "codex",
  });
  crashed.traces.bindRootInvocation("trace-1", "source-1");
  const accepted = crashed.handoffs.accept({
    sourceInvocationId: "source-1",
    targetAgentId: "grok",
    contentHash: "restart",
  });
  crashed.handoffs.markEnqueued(accepted.record.handoffId);
  crashed.invocations.start({
    id: "target-1",
    threadId: "thread-1",
    traceId: "trace-1",
    windowId: window.id,
    agentId: "grok",
    parentInvocationId: "source-1",
    triggerType: "a2a-handoff",
  });
  crashed.handoffs.bindTargetInvocation(accepted.record.handoffId, "target-1");
  crashed.close();

  const warnings = [];
  const context = createServerStorage(
    { storageMode: "sqlite", memoryDbFile: databaseFile, auditTranscript: false },
    { error() {}, warn: (line) => warnings.push(line) }
  );
  try {
    assert.equal(context.storage.invocations.get("source-1").state, "failed");
    assert.equal(context.storage.invocations.get("target-1").state, "failed");
    assert.equal(context.storage.invocations.listEvents("target-1").at(-1).kind, "invocation-end");
    assert.equal(context.storage.handoffs.get(accepted.record.handoffId).completeStatus, "failed");
    assert.equal(context.storage.traces.get("trace-1").state, "failed");
    assert.match(warnings.join("\n"), /2 invocation\(s\).*1 trace\(s\)/);
  } finally {
    await context.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sqlite audit transcript switch disables outbox archive independently", async () => {
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
    await context.close();
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
    await context.close();
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
    await context.close();
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
    auditTranscriptSink: {
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
    await context.close();
    storage.close();
  }
});

test("sqlite storage mode fails hard when SQLite initialization fails", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-storage-sqlite-fail-"));
  assert.throws(
    () => createServerStorage({ storageMode: "sqlite", memoryDbFile: tmpDir }, { error() {} }),
    /SHIFT_STORAGE_MODE=sqlite requires a working database/
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("sqlite mode refuses a missing, inactive, or legacy-validation database", async () => {
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

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStorage, openMemoryDatabase } = require("../../src/storage");
const { prepareCleanEpoch } = require("../../src/storage/offline/clean-epoch");
const { MIGRATIONS } = require("../../src/storage/schema");
const { createServerStorage } = require("../../src/storage/server-storage");

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
    { storageMode: "sqlite", memoryDbFile: databaseFile },
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

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const { runSqliteRecoveryDrill } = require("../../src/storage/recovery-drill");

function seed(storage) {
  storage.threads.create({ id: "thread-1", title: "Recovery source" });
  storage.messages.append({
    id: "message-1",
    threadId: "thread-1",
    role: "user",
    content: "restore this message",
  });
  const window = storage.windows.create({
    id: "window-1",
    threadId: "thread-1",
    agentId: "codex",
    providerKey: "codex:gpt",
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
  storage.invocations.appendEvent({
    invocationId: "invocation-1",
    kind: "text.delta",
    payload: { text: "restore this event" },
  });
  storage.recall.rebuildThread("thread-1");
}

test("SQLite backup restores authority rows and epoch into an empty directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shift-recovery-drill-"));
  const sourceFile = path.join(root, "source", "memory.sqlite");
  const drillDir = path.join(root, "drill");
  const storage = createStorage({ file: sourceFile });
  try {
    seed(storage);
  } finally {
    storage.close();
  }

  try {
    const report = await runSqliteRecoveryDrill({ sourceFile, drillDir });
    assert.equal(report.ok, true);
    assert.equal(report.mismatches.length, 0);
    assert.equal(report.integrity.ok, true);
    assert.equal(report.audit.ok, true);
    assert.equal(report.rebuilt.threads, 1);
    assert.equal(report.rebuilt.digests, 1);
    assert.equal(report.restored.counts.threads, 1);
    assert.equal(report.restored.counts.messages, 1);
    assert.equal(report.restored.counts.invocations, 1);
    assert.equal(report.restored.counts.invocation_events, 1);

    const restored = createStorage({ file: report.restoredFile });
    try {
      assert.equal(restored.messages.listForThread("thread-1")[0].content, "restore this message");
      assert.equal(restored.invocations.listEvents("invocation-1")[0].kind, "text.delta");
      assert.equal(restored.metadata.getCurrent().epochId, report.source.epoch.epochId);
    } finally {
      restored.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recovery drill refuses a non-empty target directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shift-recovery-target-"));
  const sourceFile = path.join(root, "memory.sqlite");
  const drillDir = path.join(root, "drill");
  const storage = createStorage({ file: sourceFile });
  storage.close();
  fs.mkdirSync(drillDir);
  fs.writeFileSync(path.join(drillDir, "keep.txt"), "do not overwrite");

  try {
    await assert.rejects(runSqliteRecoveryDrill({ sourceFile, drillDir }), /must be empty/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

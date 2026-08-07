const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const { auditSqliteStorage } = require("../../src/storage/offline/audit-storage");
const {
  backupDatabase,
  integrityCheck,
  rebuildThreadRecall,
} = require("../../src/storage/maintenance");

function seedBase(storage) {
  storage.threads.create({ id: "thread-1", title: "audit", createdAt: "2026-07-12T00:00:00.000Z" });
  const window = storage.windows.create({
    id: "window-1",
    threadId: "thread-1",
    agentId: "codex",
    providerKey: "codex",
    workspaceKey: "base",
    generation: 1,
    capacityTokens: 1000,
    reserveRatio: 0.2,
  });
  storage.invocations.start({
    id: "inv-1",
    threadId: "thread-1",
    windowId: window.id,
    agentId: "codex",
    startedAt: "2026-07-12T00:00:01.000Z",
  });
  storage.invocations.appendEvent({
    invocationId: "inv-1",
    sequenceNo: 0,
    kind: "invocation-start",
    payload: { agent: "codex" },
  });
  storage.invocations.appendEvent({
    invocationId: "inv-1",
    sequenceNo: 1,
    kind: "text.delta",
    payload: { text: "hello recall" },
  });
  storage.messages.append({
    id: "msg-user",
    threadId: "thread-1",
    sequenceNo: 0,
    role: "user",
    agentId: "codex",
    content: "hi",
    createdAt: "2026-07-12T00:00:00.500Z",
  });
  storage.messages.append({
    id: "msg-assistant",
    threadId: "thread-1",
    windowId: window.id,
    invocationId: "inv-1",
    sequenceNo: 1,
    role: "assistant",
    agentId: "codex",
    content: "hello recall",
    createdAt: "2026-07-12T00:00:02.000Z",
    messageType: "assistant-final",
  });
  storage.invocations.finish("inv-1", { state: "completed", exitCode: 0, signal: null });
  storage.invocations.appendEvent({
    invocationId: "inv-1",
    sequenceNo: 2,
    kind: "invocation-end",
    payload: { code: 0, signal: null },
  });
  storage.memory.capture({
    id: "mem-1",
    threadId: "thread-1",
    kind: "fact",
    content: "runtime uses sqlite",
    createdBy: "codex",
    captureKey: "fact:runtime-db",
  });
  rebuildThreadRecall(storage, "thread-1");
  return window;
}

test("audit passes for a healthy database", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    seedBase(storage);
    const report = auditSqliteStorage({ storage });
    assert.equal(report.ok, true, JSON.stringify(report.summary));
    assert.equal(report.summary.errors, 0);
  } finally {
    storage.close();
  }
});

test("audit detects missing recall and repairs with --repair", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    seedBase(storage);
    // Drop projections to simulate drift (message/event recall + L2 memory_search).
    storage.db.prepare(`DELETE FROM recall_items`).run();
    storage.db.prepare(`DELETE FROM memory_search`).run();
    storage.db.exec(`INSERT INTO recall_fts(recall_fts) VALUES('rebuild')`);
    try {
      storage.db.exec(`INSERT INTO memory_search_fts(memory_search_fts) VALUES('rebuild')`);
    } catch {
      // FTS content table may already be empty after DELETE cascade via triggers.
    }

    const dirty = auditSqliteStorage({ storage });
    assert.equal(dirty.ok, false);
    assert.ok(dirty.summary.byCode["message-recall-missing"] >= 1);
    assert.ok(dirty.summary.byCode["event-recall-missing"] >= 1);
    assert.ok(dirty.summary.byCode["memory-recall-missing"] >= 1);

    const repaired = auditSqliteStorage({ storage, repair: true });
    assert.equal(repaired.repairs.length > 0, true);
    assert.equal(repaired.ok, true, JSON.stringify(repaired.summary));
    assert.ok(repaired.initialFindings.length > 0);
    assert.equal(repaired.findings.length, 0);
    const after = auditSqliteStorage({ storage });
    assert.equal(after.ok, true, JSON.stringify(after.summary));
  } finally {
    storage.close();
  }
});

test("audit flags completed invocation without invocation-end", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    seedBase(storage);
    storage.db.prepare(`DELETE FROM invocation_events WHERE kind = 'invocation-end'`).run();
    // Keep terminal state.
    const report = auditSqliteStorage({ storage });
    assert.equal(report.ok, false);
    assert.ok(report.findings.some((item) => item.code === "terminal-missing-end-event"));
  } finally {
    storage.close();
  }
});

test("audit flags assistant-final without invocation", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    seedBase(storage);
    storage.db
      .prepare(
        `INSERT INTO messages
          (id, thread_id, window_id, invocation_id, sequence_no, role, agent_id, content, metadata_json, created_at, message_type)
         VALUES
          ('msg-orphan', 'thread-1', NULL, NULL, 2, 'assistant', 'codex', 'orphan', NULL, '2026-07-12T00:00:03.000Z', 'assistant-final')`
      )
      .run();
    const report = auditSqliteStorage({ storage });
    assert.ok(report.findings.some((item) => item.code === "assistant-final-missing-invocation"));
  } finally {
    storage.close();
  }
});

test("audit warns about successful tool events with fatal output without rewriting history", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    seedBase(storage);
    storage.invocations.appendEvent({
      invocationId: "inv-1",
      sequenceNo: 3,
      kind: "tool.finished",
      payload: {
        toolId: "legacy-fatal",
        toolName: "bash",
        status: "ok",
        exitCode: 0,
        output: "fatal: 'master' is already used by worktree",
      },
    });
    rebuildThreadRecall(storage, "thread-1");

    const report = auditSqliteStorage({ storage });
    assert.equal(report.ok, true, JSON.stringify(report.summary));
    assert.equal(report.summary.byCode.TOOL_OUTCOME_CONTRADICTION, 1);
    const event = storage.invocations.getEvent("inv-1", 3);
    assert.equal(event.payload.status, "ok");
    assert.equal(event.payload.exitCode, 0);
  } finally {
    storage.close();
  }
});

test("maintenance backup and integrity helpers work on a file database", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shift-backup-"));
  const dbFile = path.join(root, "memory.sqlite");
  const backupFile = path.join(root, "memory.backup.sqlite");
  const storage = createStorage({ file: dbFile });
  try {
    seedBase(storage);
    const integrity = integrityCheck(storage.db);
    assert.equal(integrity.ok, true);
    const backup = await backupDatabase(storage.db, backupFile);
    assert.equal(fs.existsSync(backup.destination), true);
    assert.ok(backup.bytes > 0);

    const restored = createStorage({ file: backupFile });
    try {
      assert.equal(restored.messages.listForThread("thread-1").length, 2);
      assert.equal(restored.invocations.get("inv-1").state, "completed");
    } finally {
      restored.close();
    }
  } finally {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

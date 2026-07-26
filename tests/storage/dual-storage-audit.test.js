const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { auditDualStorage } = require("../../src/storage/audit-dual-storage");
const { createStorage } = require("../../src/storage");

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shift-dual-audit-"));
  const sessionsFile = path.join(root, "sessions.json");
  const transcriptDir = path.join(root, "transcripts");
  const storage = createStorage({ file: ":memory:" });
  return {
    root,
    sessionsFile,
    transcriptDir,
    storage,
    close() {
      storage.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function seedThread(storage, input = {}) {
  const id = input.id || "thread-1";
  const createdAt = input.createdAt || "2026-07-26T00:00:00.000Z";
  storage.threads.create({
    id,
    title: input.title || "Storage audit",
    projectDir: input.projectDir || "C:\\project",
    lastAgentId: input.lastAgent || "codex",
    createdAt,
    updatedAt: createdAt,
  });
  return { id, createdAt };
}

function seedMessage(storage, threadId, input = {}) {
  return storage.messages.append({
    id: input.id || "msg-1",
    threadId,
    role: input.role || "user",
    agentId: input.agent || "codex",
    content: input.content || "hello",
    createdAt: input.createdAt || "2026-07-26T00:00:01.000Z",
    messageType: input.messageType || "user",
  });
}

function writeSessions(file, sessions) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ sessions, lastSessionId: null }, null, 2)}\n`);
}

function writeTranscript(root, threadId, invocationId, events) {
  const dir = path.join(root, threadId, "invocations");
  fs.mkdirSync(dir, { recursive: true });
  const text = events
    .map((event, index) =>
      JSON.stringify({
        ts: `2026-07-26T00:00:0${index}.000Z`,
        kind: event.kind,
        payload: event.payload || {},
      })
    )
    .join("\n");
  fs.writeFileSync(path.join(dir, `${invocationId}.jsonl`), `${text}\n`);
}

function fileSession(thread, messages, overrides = {}) {
  return {
    id: thread.id,
    title: "Storage audit",
    createdAt: thread.createdAt,
    projectDir: "C:\\project",
    lastAgent: "codex",
    worktree: null,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      agent: message.agentId,
      content: message.content,
      createdAt: message.createdAt,
      messageType: message.messageType,
      ...(message.invocationId ? { invocationId: message.invocationId } : {}),
    })),
    ...overrides,
  };
}

test("dual audit reports converged active threads and messages", () => {
  const fixture = createFixture();
  try {
    const thread = seedThread(fixture.storage);
    const message = seedMessage(fixture.storage, thread.id);
    writeSessions(fixture.sessionsFile, {
      [thread.id]: fileSession(thread, [message]),
    });

    const report = auditDualStorage({
      storage: fixture.storage,
      sessionsFile: fixture.sessionsFile,
      transcriptDir: fixture.transcriptDir,
    });

    assert.equal(report.ok, true);
    assert.equal(report.converged, true);
    assert.deepEqual(report.totals.files, {
      threads: 1,
      messages: 1,
      invocations: 0,
      events: 0,
    });
    assert.deepEqual(report.totals.sqlite, report.totals.files);
    assert.deepEqual(report.metrics, {
      fileThreadsPresentInSqlite: 1,
      sqliteThreadsPresentInFiles: 1,
      fileMessagesPresentInSqlite: 1,
      sqliteMessagesPresentInFiles: 1,
      fileInvocationsPresentInSqlite: 1,
      sqliteInvocationsPresentInFiles: 1,
      mirroredInvocationsWithExactEventKinds: 1,
    });
    assert.equal(report.findings.length, 0);
  } finally {
    fixture.close();
  }
});

test("dual audit reports missing and changed message mirrors", () => {
  const fixture = createFixture();
  try {
    const thread = seedThread(fixture.storage);
    const changed = seedMessage(fixture.storage, thread.id, {
      id: "msg-changed",
      content: "sqlite content",
    });
    seedMessage(fixture.storage, thread.id, { id: "msg-sqlite-only", content: "sqlite only" });
    writeSessions(fixture.sessionsFile, {
      [thread.id]: fileSession(thread, [
        { ...changed, content: "file content" },
        {
          id: "msg-file-only",
          role: "user",
          agentId: "codex",
          content: "file only",
          createdAt: "2026-07-26T00:00:02.000Z",
          messageType: "user",
          invocationId: null,
        },
      ]),
    });

    const report = auditDualStorage({
      storage: fixture.storage,
      sessionsFile: fixture.sessionsFile,
      transcriptDir: fixture.transcriptDir,
    });

    assert.equal(report.ok, false);
    assert.equal(report.converged, false);
    assert.equal(report.summary.byCode["message-content-mismatch"], 1);
    assert.equal(report.summary.byCode["sqlite-message-missing"], 1);
    assert.equal(report.summary.byCode["file-message-missing"], 1);
  } finally {
    fixture.close();
  }
});

test("dual audit compares invocation identity and canonical event kind counts", () => {
  const fixture = createFixture();
  try {
    const thread = seedThread(fixture.storage);
    writeSessions(fixture.sessionsFile, {
      [thread.id]: fileSession(thread, []),
    });
    const window = fixture.storage.windows.create({
      id: "window-1",
      threadId: thread.id,
      agentId: "codex",
      providerKey: "codex",
      workspaceKey: "base",
      generation: 1,
      capacityTokens: 1000,
      reserveRatio: 0.2,
    });
    fixture.storage.invocations.start({
      id: "inv-1",
      threadId: thread.id,
      windowId: window.id,
      agentId: "codex",
      startedAt: "2026-07-26T00:00:02.000Z",
    });
    fixture.storage.invocations.appendEvent({
      invocationId: "inv-1",
      kind: "invocation-start",
      payload: {},
    });
    fixture.storage.invocations.appendEvent({
      invocationId: "inv-1",
      kind: "text.delta",
      payload: { text: "answer" },
    });
    writeTranscript(fixture.transcriptDir, thread.id, "inv-1", [
      { kind: "invocation-start" },
      { kind: "thinking.delta" },
    ]);

    const report = auditDualStorage({
      storage: fixture.storage,
      sessionsFile: fixture.sessionsFile,
      transcriptDir: fixture.transcriptDir,
    });

    assert.equal(report.summary.byCode["invocation-event-kinds-mismatch"], 1);
    const finding = report.findings.find((item) => item.code === "invocation-event-kinds-mismatch");
    assert.deepEqual(finding.fileKinds, {
      "invocation-start": 1,
      "thinking.delta": 1,
    });
    assert.deepEqual(finding.sqliteKinds, {
      "invocation-start": 1,
      "text.delta": 1,
    });
  } finally {
    fixture.close();
  }
});

test("dual audit excludes archived SQLite threads from active convergence", () => {
  const fixture = createFixture();
  try {
    const thread = seedThread(fixture.storage);
    seedMessage(fixture.storage, thread.id);
    fixture.storage.threads.archive(thread.id);
    writeSessions(fixture.sessionsFile, {});

    const report = auditDualStorage({
      storage: fixture.storage,
      sessionsFile: fixture.sessionsFile,
      transcriptDir: fixture.transcriptDir,
    });

    assert.equal(report.converged, true);
    assert.equal(report.totals.sqlite.threads, 0);
    assert.equal(report.findings.length, 0);
  } finally {
    fixture.close();
  }
});

test("dual audit detects malformed transcript JSON", () => {
  const fixture = createFixture();
  try {
    const thread = seedThread(fixture.storage);
    writeSessions(fixture.sessionsFile, {
      [thread.id]: fileSession(thread, []),
    });
    const dir = path.join(fixture.transcriptDir, thread.id, "invocations");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "inv-bad.jsonl"), "{bad json}\n");

    const report = auditDualStorage({
      storage: fixture.storage,
      sessionsFile: fixture.sessionsFile,
      transcriptDir: fixture.transcriptDir,
    });

    assert.equal(report.summary.byCode["transcript-json-invalid"], 1);
    assert.equal(report.summary.byCode["sqlite-invocation-missing"], 1);
  } finally {
    fixture.close();
  }
});

test("dual audit surfaces malformed sessions JSON instead of treating it as empty", () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(fixture.sessionsFile, "{bad json}\n");

    const report = auditDualStorage({
      storage: fixture.storage,
      sessionsFile: fixture.sessionsFile,
      transcriptDir: fixture.transcriptDir,
    });

    assert.equal(report.summary.byCode["sessions-json-invalid"], 1);
    assert.equal(report.ok, false);
  } finally {
    fixture.close();
  }
});

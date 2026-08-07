const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const { migrateRuntimeToSqlite } = require("../../src/storage/offline/migrate-runtime");
const { auditSqliteStorage } = require("../../src/storage/offline/audit-storage");
const { copyLegacyRuntimeFixture } = require("../helpers/legacy-runtime-fixture");

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeJsonl(file, events) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
}

function fixtureRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "shift-migrate-"));
}

test("migrate imports sessions and transcript events into SQLite", async () => {
  const root = copyLegacyRuntimeFixture("shift-migrate-fixture-");
  const sessionsFile = path.join(root, "sessions.json");
  const transcriptDir = path.join(root, "transcripts");
  const memoryDbFile = path.join(root, "memory.sqlite");

  try {
    const first = await migrateRuntimeToSqlite({
      sessionsFile,
      transcriptDir,
      memoryDbFile,
    });
    assert.equal(first.totals.threads, 1);
    assert.ok(first.totals.messagesImported >= 2);
    assert.ok(first.totals.eventsImported >= 5);
    assert.equal(first.totals.invocationsCreated, 1);
    assert.equal(first.totals.memoriesImported, 0);
    assert.equal(first.integrity.ok, true);

    const storage = createStorage({ file: memoryDbFile });
    try {
      assert.equal(storage.threads.get("thread-1").title, "Hello world title");
      assert.equal(storage.messages.listForThread("thread-1").length, 2);
      assert.equal(storage.invocations.get("inv-1").state, "completed");
      assert.deepEqual(
        storage.invocations.listEvents("inv-1").map((event) => event.kind),
        ["invocation-start", "text.delta", "handoff", "memory-captured", "invocation-end"]
      );
      assert.equal(storage.memories.getByCaptureKey("thread-1", "handoff:inv-1:gemini:0"), null);
      assert.ok(storage.recall.search("thread-1", "synthetic fixture").length >= 1);
      assert.ok(storage.recall.search("thread-1", "review").length >= 1);

      // Second run is idempotent.
      const second = await migrateRuntimeToSqlite({
        sessionsFile,
        transcriptDir,
        storage,
      });
      assert.equal(second.totals.messagesImported, 0);
      assert.equal(second.totals.eventsImported, 0);
      assert.equal(second.totals.invocationsCreated, 0);
      assert.equal(storage.messages.listForThread("thread-1").length, 2);
      assert.equal(storage.invocations.listEvents("inv-1").length, 5);

      const audit = auditSqliteStorage({ storage });
      assert.equal(audit.ok, true, JSON.stringify(audit.summary));
    } finally {
      storage.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("migrate dry-run does not write SQLite rows", async () => {
  const root = fixtureRoot();
  const sessionsFile = path.join(root, "sessions.json");
  const transcriptDir = path.join(root, "transcripts");
  const memoryDbFile = path.join(root, "memory.sqlite");
  writeJson(sessionsFile, {
    sessions: {
      "thread-dry": {
        id: "thread-dry",
        title: "dry",
        createdAt: "2026-07-12T00:00:00.000Z",
        messages: [{ id: "m1", role: "user", content: "x", createdAt: "2026-07-12T00:00:01.000Z" }],
      },
    },
  });
  writeJsonl(path.join(transcriptDir, "thread-dry", "invocations", "inv-dry.jsonl"), [
    { ts: "2026-07-12T00:00:02.000Z", kind: "invocation-start", payload: { agent: "codex" } },
  ]);

  try {
    const report = await migrateRuntimeToSqlite({
      sessionsFile,
      transcriptDir,
      memoryDbFile,
      dryRun: true,
    });
    assert.equal(report.dryRun, true);
    assert.equal(report.totals.threads, 1);
    // dry-run still opens/creates the DB file via createStorage; ensure no business rows.
    const storage = createStorage({ file: memoryDbFile });
    try {
      assert.equal(storage.threads.list().length, 0);
    } finally {
      storage.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("migrate resumes after interrupted first pass", async () => {
  const root = fixtureRoot();
  const sessionsFile = path.join(root, "sessions.json");
  const transcriptDir = path.join(root, "transcripts");
  const memoryDbFile = path.join(root, "memory.sqlite");
  writeJson(sessionsFile, {
    sessions: {
      "thread-resume": {
        id: "thread-resume",
        title: "resume",
        createdAt: "2026-07-12T00:00:00.000Z",
        messages: [
          {
            id: "u1",
            role: "user",
            agent: "codex",
            content: "continue",
            createdAt: "2026-07-12T00:00:01.000Z",
          },
        ],
      },
    },
  });
  writeJsonl(path.join(transcriptDir, "thread-resume", "invocations", "inv-resume.jsonl"), [
    { ts: "2026-07-12T00:00:02.000Z", kind: "invocation-start", payload: { agent: "codex" } },
    { ts: "2026-07-12T00:00:03.000Z", kind: "text.delta", payload: { text: "partial" } },
    { ts: "2026-07-12T00:00:04.000Z", kind: "invocation-end", payload: { code: 0, signal: null } },
  ]);

  try {
    // Partial import: messages only, simulating crash before events.
    const storage = createStorage({ file: memoryDbFile });
    storage.threads.create({
      id: "thread-resume",
      title: "resume",
      createdAt: "2026-07-12T00:00:00.000Z",
    });
    storage.messages.append({
      id: "u1",
      threadId: "thread-resume",
      sequenceNo: 0,
      role: "user",
      agentId: "codex",
      content: "continue",
      createdAt: "2026-07-12T00:00:01.000Z",
    });
    storage.close();

    const report = await migrateRuntimeToSqlite({
      sessionsFile,
      transcriptDir,
      memoryDbFile,
    });
    assert.equal(report.totals.messagesImported, 0);
    assert.ok(report.totals.eventsImported >= 3);
    assert.equal(report.totals.invocationsCreated, 1);

    const reopened = createStorage({ file: memoryDbFile });
    try {
      assert.equal(reopened.invocations.get("inv-resume").state, "completed");
      assert.equal(reopened.invocations.listEvents("inv-resume").length, 3);
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("migrate restores invocation parent and trigger causality", async () => {
  const root = fixtureRoot();
  const sessionsFile = path.join(root, "sessions.json");
  const transcriptDir = path.join(root, "transcripts");
  const memoryDbFile = path.join(root, "memory.sqlite");
  writeJson(sessionsFile, {
    sessions: {
      "thread-causal": {
        id: "thread-causal",
        createdAt: "2026-07-12T00:00:00.000Z",
        messages: [
          {
            id: "msg-user",
            role: "user",
            agent: "codex",
            content: "start",
            createdAt: "2026-07-12T00:00:01.000Z",
          },
          {
            id: "msg-route",
            role: "system",
            agent: "system",
            content: "codex to opencode",
            messageType: "a2a-route",
            createdAt: "2026-07-12T00:00:03.000Z",
          },
        ],
      },
    },
  });
  writeJsonl(path.join(transcriptDir, "thread-causal", "invocations", "inv-child.jsonl"), [
    {
      ts: "2026-07-12T00:00:04.000Z",
      kind: "invocation-start",
      payload: {
        agent: "opencode",
        parentInvocationId: "inv-parent",
        triggerMessageId: "msg-route",
        triggerType: "a2a-handoff",
      },
    },
  ]);
  writeJsonl(path.join(transcriptDir, "thread-causal", "invocations", "inv-parent.jsonl"), [
    {
      ts: "2026-07-12T00:00:02.000Z",
      kind: "invocation-start",
      payload: {
        agent: "codex",
        triggerMessageId: "msg-user",
        triggerType: "user-message",
      },
    },
  ]);

  try {
    await migrateRuntimeToSqlite({ sessionsFile, transcriptDir, memoryDbFile });
    const storage = createStorage({ file: memoryDbFile });
    try {
      const parent = storage.invocations.get("inv-parent");
      const child = storage.invocations.get("inv-child");
      assert.equal(parent.triggerMessageId, "msg-user");
      assert.equal(parent.triggerType, "user-message");
      assert.equal(child.parentInvocationId, "inv-parent");
      assert.equal(child.triggerMessageId, "msg-route");
      assert.equal(child.triggerType, "a2a-handoff");
    } finally {
      storage.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

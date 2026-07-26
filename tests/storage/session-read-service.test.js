const assert = require("node:assert/strict");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const { createSessionReadService } = require("../../src/storage/session-read-service");

function createFixture() {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({
    id: "thread-1",
    title: "SQLite title",
    projectDir: "C:/repo",
    lastAgentId: "codex",
    createdAt: "2026-07-12T00:00:00.000Z",
  });
  storage.messages.append({
    id: "message-1",
    threadId: "thread-1",
    sequenceNo: 0,
    role: "user",
    agentId: "codex",
    content: "SQLite message",
    metadata: { activeSkills: ["memory"] },
    createdAt: "2026-07-12T00:00:01.000Z",
  });
  const fileSession = {
    id: "thread-1",
    title: "Old file title",
    createdAt: "2026-07-12T00:00:00.000Z",
    messages: [],
    worktree: { branch: "worktree-branch" },
    projectDir: "C:/old",
    lastagent: "opencode",
  };
  const fileOnly = {
    id: "legacy-thread",
    title: "Legacy",
    createdAt: "2026-07-11T00:00:00.000Z",
    messageCount: 2,
    lastagent: "opencode",
  };
  const fileStore = {
    getSession: (_file, id) => (id === "thread-1" ? fileSession : null),
    listSessions: () => [{ ...fileSession, messageCount: 0 }, fileOnly],
  };
  return { storage, fileSession, fileOnly, fileStore };
}

test("sqlite session reads use only durable state", () => {
  const { storage } = createFixture();
  let fileReads = 0;
  try {
    const service = createSessionReadService({
      mode: "sqlite",
      storage,
      fileStore: {
        getSession() {
          fileReads += 1;
          throw new Error("legacy getSession must not run");
        },
        listSessions() {
          fileReads += 1;
          throw new Error("legacy listSessions must not run");
        },
      },
    });
    const session = service.getSession("sessions.json", "thread-1");
    assert.equal(session.title, "SQLite title");
    assert.equal(session.projectDir, "C:/repo");
    assert.equal(session.lastAgent, "codex");
    assert.equal(session.worktree, null);
    assert.equal(session.messages.length, 1);
    assert.equal(session.messages[0].content, "SQLite message");
    assert.deepEqual(session.messages[0].activeSkills, ["memory"]);
    assert.equal(fileReads, 0);
  } finally {
    storage.close();
  }
});

test("sqlite session list excludes legacy file-only sessions", () => {
  const { storage } = createFixture();
  try {
    const service = createSessionReadService({ mode: "sqlite", storage });
    const sessions = service.listSessions("sessions.json");
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, "thread-1");
    assert.equal(sessions[0].messageCount, 1);
  } finally {
    storage.close();
  }
});

test("files mode reads the file store while sqlite failures remain visible", () => {
  const { storage, fileSession, fileStore } = createFixture();
  const errors = [];
  try {
    const files = createSessionReadService({ mode: "files", storage, fileStore });
    assert.equal(files.getSession("sessions.json", "thread-1"), fileSession);

    const broken = createSessionReadService({
      mode: "sqlite",
      storage: {
        threads: {
          get: () => {
            throw new Error("busy");
          },
          listWithMessageCounts: () => {
            throw new Error("busy");
          },
        },
        messages: {
          listForThread: () => {
            throw new Error("busy");
          },
        },
      },
      fileStore,
      logger: { error: (message) => errors.push(message) },
    });
    assert.throws(() => broken.getSession("sessions.json", "thread-1"), /busy/);
    assert.throws(() => broken.listSessions("sessions.json"), /busy/);
    assert.equal(errors.length, 2);
  } finally {
    storage.close();
  }
});

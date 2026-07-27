/**
 * Project-scoped memory: cross-thread invalidate + topic canon + cross-kind supersede.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const { canonicalizeTopic } = require("../../src/storage/memory-topic-canon");
const { createMemoryCapture } = require("../../src/storage/memory-capture");

function createProjectFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shift-mem-access-"));
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "thread-a", projectDir: dir, title: "A" });
  storage.threads.create({ id: "thread-b", projectDir: dir, title: "B" });
  storage.threads.create({
    id: "thread-other",
    projectDir: fs.mkdtempSync(path.join(os.tmpdir(), "shift-other-proj-")),
    title: "Other",
  });
  return { storage, dir };
}

test("canonicalizeTopic maps auth aliases", () => {
  assert.equal(canonicalizeTopic("auth-session-ttl"), "auth-token-ttl");
  assert.equal(canonicalizeTopic("auth-token-ttl"), "auth-token-ttl");
  assert.equal(canonicalizeTopic("auth-no-refresh-token"), "auth-no-refresh");
  assert.equal(canonicalizeTopic("dev-port"), "local-dev-port");
  assert.equal(canonicalizeTopic("storage-primary"), "storage-primary");
});

test("canAccessFromThread allows project memory from sibling thread", () => {
  const { storage, dir } = createProjectFixture();
  try {
    const written = storage.memory.createProduct({
      threadId: "thread-a",
      kind: "decision",
      topic: "auth-token-ttl",
      content: "TTL 24h",
      createdBy: "agent",
      writeChannel: "agent",
    });
    assert.equal(written.scope, "project");
    assert.equal(storage.memory.canAccessFromThread(written.memory, "thread-b"), true);
    assert.equal(storage.memory.canAccessFromThread(written.memory, "thread-a"), true);
    assert.equal(storage.memory.canAccessFromThread(written.memory, "thread-other"), false);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sibling thread can invalidate project memory written on origin thread", () => {
  const { storage, dir } = createProjectFixture();
  try {
    const written = storage.memory.createProduct({
      threadId: "thread-a",
      kind: "decision",
      topic: "auth-token-ttl",
      content: "TTL 24 hours",
      createdBy: "agent",
      writeChannel: "agent",
    });
    assert.equal(storage.memory.canAccessFromThread(written.memory, "thread-b"), true);
    const invalidated = storage.memory.invalidate(written.memory.id, {
      invalidatedBy: "grok",
      reason: "user revised to 7 days",
    });
    assert.equal(invalidated.status, "invalidated");
    assert.equal(storage.memories.get(written.memory.id).status, "invalidated");
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("topic alias supersedes prior active product memory", () => {
  const { storage, dir } = createProjectFixture();
  try {
    const first = storage.memory.createProduct({
      threadId: "thread-a",
      kind: "decision",
      topic: "auth-session-ttl",
      content: "TTL 24h / 86400",
      createdBy: "agent",
      writeChannel: "agent",
    });
    assert.equal(first.topic, "auth-token-ttl");

    const second = storage.memory.createProduct({
      threadId: "thread-b",
      kind: "decision",
      topic: "auth-token-ttl",
      content: "TTL 7 days / 604800",
      createdBy: "agent",
      writeChannel: "agent",
    });
    assert.equal(second.topic, "auth-token-ttl");
    assert.equal(storage.memories.get(first.memory.id).status, "superseded");
    assert.equal(storage.memories.get(second.memory.id).status, "captured");

    const active = storage.memory.listActiveForTurn("thread-b", { limit: 50 });
    const ttlActive = active.filter(
      (m) => (m.topic || m.metadata?.topic) === "auth-token-ttl" && m.status !== "superseded"
    );
    assert.equal(ttlActive.length, 1);
    assert.match(ttlActive[0].content, /7|604800/);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("same canon topic decision then fact keeps one active", () => {
  const { storage, dir } = createProjectFixture();
  try {
    const decision = storage.memory.createProduct({
      threadId: "thread-a",
      kind: "decision",
      topic: "local-dev-port",
      content: "port 8787",
      createdBy: "agent",
      writeChannel: "agent",
    });
    const fact = storage.memory.createProduct({
      threadId: "thread-a",
      kind: "fact",
      topic: "dev-port",
      content: "local port 8787",
      createdBy: "agent",
      writeChannel: "agent",
    });
    assert.equal(fact.topic, "local-dev-port");
    assert.equal(storage.memories.get(decision.memory.id).status, "superseded");
    assert.equal(storage.memories.get(fact.memory.id).status, "captured");

    const active = storage.memory.listActiveForTurn("thread-a", { limit: 50 });
    const ports = active.filter((m) => (m.topic || m.metadata?.topic) === "local-dev-port");
    assert.equal(ports.length, 1);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("window-seal partial false for post-turn reason", () => {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "t1", projectDir: "C:/proj", title: "t" });
  const window = storage.windows.create({
    id: "win-1",
    threadId: "t1",
    agentId: "codex",
    providerKey: "codex:test",
    workspaceKey: "base:C:/proj",
    generation: 1,
    capacityTokens: 100000,
  });
  storage.invocations.start({
    id: "inv-1",
    threadId: "t1",
    windowId: window.id,
    agentId: "codex",
    startedAt: new Date().toISOString(),
  });
  const capture = createMemoryCapture({
    memoryService: storage.memory,
    eventStore: {
      append() {},
    },
  });
  try {
    const complete = capture.captureWindowSeal({
      threadId: "t1",
      invocationId: "inv-1",
      windowId: "win-1",
      agentId: "codex",
      generation: 1,
      ratio: 0.92,
      reason: "post-turn-soft-ratio",
      assistantContent: "full answer body here",
      partial: false,
      invocationState: "completed",
    });
    assert.equal(complete.captured, true);
    assert.equal(complete.memory.metadata.partial, false);
    assert.match(complete.memory.content, /partial=false/);
    assert.match(complete.memory.content, /完整轮次快照/);
    assert.doesNotMatch(complete.memory.content, /中断快照/);

    const partial = capture.captureWindowSeal({
      threadId: "t1",
      invocationId: "inv-1",
      windowId: "win-2",
      agentId: "codex",
      generation: 1,
      ratio: 1.1,
      reason: "pre-call-projected",
      assistantContent: "",
      invocationState: "pre-call-rotate",
    });
    assert.equal(partial.memory.metadata.partial, true);
    assert.match(partial.memory.content, /中断快照|partial=true/);
  } finally {
    storage.close();
  }
});

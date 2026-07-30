const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const { createRecallService } = require("../../src/storage/recall-service");
const { buildActiveMemoryCard } = require("../../src/session/bootstrap");

function emptyTranscript() {
  return {
    listInvocationsWithMeta: async () => [],
    searchTranscript: async () => [],
    readInvocationPage: async () => ({ events: [], total: 0, from: 0, limit: 200 }),
  };
}

function createProjectFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shift-xthread-"));
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "thread-a", projectDir: dir, title: "A" });
  storage.threads.create({ id: "thread-b", projectDir: dir, title: "B" });
  return { storage, dir };
}

test("decision written in thread A is injected into thread B same project", async () => {
  const { storage, dir } = createProjectFixture();
  try {
    const threadA = storage.threads.get("thread-a");
    const threadB = storage.threads.get("thread-b");
    assert.ok(threadA.projectKey);
    assert.equal(threadA.projectKey, threadB.projectKey);

    const written = storage.memory.createProduct({
      threadId: "thread-a",
      kind: "decision",
      topic: "storage-primary",
      content: "在线读写以 SQLite 为准",
      createdBy: "user",
      writeChannel: "user",
    });
    assert.equal(written.scope, "project");
    assert.equal(written.memory.scope, "project");
    assert.equal(written.memory.projectKey, threadA.projectKey);

    const forB = storage.memory.listActiveForTurn("thread-b", { limit: 20 });
    assert.ok(forB.some((m) => m.id === written.memory.id));

    const service = createRecallService({ storage, transcript: emptyTranscript() });
    const pack = await service.retrieveForTurn({
      threadId: "thread-b",
      prompt: "SQLite 存储怎么定的？",
      budgetChars: 3000,
    });
    assert.ok(pack.items.some((m) => m.id === written.memory.id));
    assert.match(pack.rendered, /SQLite/);
    assert.equal(pack.stats.availability.state, "available");

    const agentResult = await service.searchForAgent(
      { threadId: "thread-b", invocationId: "invocation-b", caller: "mcp" },
      { query: "SQLite 存储", layers: ["memory"] }
    );
    const projectHit = agentResult.hits.find(
      (hit) => hit.source.memoryId === written.memory.id
    );
    assert.ok(projectHit);
    assert.equal(projectHit.metadata.scope, "project");
    assert.equal(projectHit.metadata.topic, "storage-primary");
    assert.equal(projectHit.source.sourceAvailable, false);
    assert.equal(Object.hasOwn(projectHit.source, "invocationId"), false);

    const card = await buildActiveMemoryCard({
      threadId: "thread-b",
      prompt: "继续",
      retrieveSource: service,
      memorySource: storage.memory,
    });
    assert.ok(card.items.some((m) => m.id === written.memory.id));
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("purge origin thread keeps project memory searchable and injectable", async () => {
  const { storage, dir } = createProjectFixture();
  try {
    const written = storage.memory.createProduct({
      threadId: "thread-a",
      kind: "constraint",
      topic: "no-force-push",
      content: "禁止对 main 使用 force push",
      createdBy: "user",
      writeChannel: "user",
    });
    const projectKey = written.memory.projectKey;

    assert.equal(storage.threads.purge("thread-a", { purgedBy: "test" }), true);
    assert.equal(storage.threads.get("thread-a"), null);

    const survived = storage.memories.get(written.memory.id);
    assert.ok(survived);
    assert.equal(survived.originThreadId, null);
    assert.equal(survived.projectKey, projectKey);

    const hits = storage.memories.searchMemory("force push", { projectKey, limit: 10 });
    assert.ok(hits.some((h) => h.memoryId === written.memory.id));

    const forB = storage.memory.listActiveForTurn("thread-b", { limit: 20 });
    assert.ok(forB.some((m) => m.id === written.memory.id));

    const service = createRecallService({ storage, transcript: emptyTranscript() });
    const result = await service.searchSession("thread-b", "force push", {
      layers: ["memory"],
      memoryScope: "all",
    });
    assert.ok(result.hits.some((h) => h.memoryId === written.memory.id || h.sourceId === written.memory.id));
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("thread supersession updates project active key across threads", () => {
  const { storage, dir } = createProjectFixture();
  try {
    const v1 = storage.memory.createProduct({
      threadId: "thread-a",
      kind: "decision",
      topic: "auth",
      content: "use cookie sessions",
      createdBy: "user",
      writeChannel: "user",
    });
    const v2 = storage.memory.createProduct({
      threadId: "thread-b",
      kind: "decision",
      topic: "auth",
      content: "use signed cookie sessions",
      createdBy: "user",
      writeChannel: "user",
    });
    assert.equal(storage.memories.get(v1.memory.id).status, "superseded");
    assert.equal(storage.memories.get(v1.memory.id).supersededBy, v2.memory.id);

    const activeA = storage.memory.listActiveForTurn("thread-a");
    const activeB = storage.memory.listActiveForTurn("thread-b");
    assert.ok(activeA.every((m) => m.id !== v1.memory.id || m.status !== "captured"));
    assert.ok(activeA.some((m) => m.id === v2.memory.id));
    assert.ok(activeB.some((m) => m.id === v2.memory.id));
    assert.equal(activeA.filter((m) => m.supersessionKey === "decision:auth").length, 1);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fact defaults to thread scope and does not leak across threads", () => {
  const { storage, dir } = createProjectFixture();
  try {
    const fact = storage.memory.createProduct({
      threadId: "thread-a",
      kind: "fact",
      topic: "temp-port",
      content: "debug port 9999 for this thread only",
      createdBy: "agent:codex",
      writeChannel: "agent",
    });
    assert.equal(fact.scope, "thread");
    assert.equal(fact.memory.scope, "thread");

    const forB = storage.memory.listActiveForTurn("thread-b");
    assert.ok(!forB.some((m) => m.id === fact.memory.id));

    const forA = storage.memory.listActiveForTurn("thread-a");
    assert.ok(forA.some((m) => m.id === fact.memory.id));
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("unconfirmed lesson is not injected; confirmed lesson is", () => {
  const { storage, dir } = createProjectFixture();
  try {
    const lesson = storage.memory.createProduct({
      threadId: "thread-a",
      kind: "lesson",
      topic: "worktree-cleanup",
      content: "坑: 在 worktree 内 remove 自己\n根因: 丢 CWD\n防护: 先 cd 回主仓",
      createdBy: "agent:codex",
      writeChannel: "agent",
    });
    assert.equal(lesson.scope, "project");
    assert.equal(lesson.memory.status, "captured");

    let forB = storage.memory.listActiveForTurn("thread-b");
    assert.ok(!forB.some((m) => m.id === lesson.memory.id));

    storage.memory.confirm(lesson.memory.id, {
      confirmedBy: "user",
      confirmationSource: "ui",
    });
    forB = storage.memory.listActiveForTurn("thread-b");
    assert.ok(forB.some((m) => m.id === lesson.memory.id));
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("searchSession memoryScope=project only returns project memories", async () => {
  const { storage, dir } = createProjectFixture();
  try {
    storage.memory.createProduct({
      threadId: "thread-a",
      kind: "decision",
      topic: "proj-only",
      content: "project decision alpha",
      createdBy: "user",
      writeChannel: "user",
    });
    storage.memory.createProduct({
      threadId: "thread-a",
      kind: "fact",
      topic: "local-only",
      content: "thread fact beta",
      createdBy: "user",
      writeChannel: "user",
    });

    const service = createRecallService({ storage, transcript: emptyTranscript() });
    const projectOnly = await service.searchSession("thread-b", "alpha", {
      layers: ["memory"],
      memoryScope: "project",
    });
    assert.ok(projectOnly.hits.some((h) => /alpha/.test(h.content || h.snippet || "")));

    const threadOnly = await service.searchSession("thread-a", "beta", {
      layers: ["memory"],
      memoryScope: "thread",
    });
    assert.ok(threadOnly.hits.some((h) => /beta/.test(h.content || h.snippet || "")));

    const fromB = await service.searchSession("thread-b", "beta", {
      layers: ["memory"],
      memoryScope: "thread",
    });
    assert.ok(!fromB.hits.some((h) => /beta/.test(h.content || h.snippet || "")));
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("empty projectDir forces thread scope even for decision", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    storage.threads.create({ id: "t-empty", projectDir: "" });
    const decision = storage.memory.createProduct({
      threadId: "t-empty",
      kind: "decision",
      topic: "local",
      content: "stay thread scoped without project",
      createdBy: "user",
      writeChannel: "user",
    });
    assert.equal(decision.scope, "thread");
  } finally {
    storage.close();
  }
});

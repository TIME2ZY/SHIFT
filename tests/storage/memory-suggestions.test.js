const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStorage } = require("../../src/storage");

function createFixture(withProject = true) {
  const dir = withProject ? fs.mkdtempSync(path.join(os.tmpdir(), "shift-sugg-")) : null;
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({
    id: "thread-1",
    projectDir: dir || "",
    title: "t1",
  });
  return { storage, dir };
}

function sampleAnchors(threadId = "thread-1") {
  return [
    {
      type: "message",
      ref: "msg-anchor-1",
      originThreadId: threadId,
      label: "user said use sqlite",
    },
  ];
}

test("suggestion requires anchors and stays out of active inject until accepted", () => {
  const { storage, dir } = createFixture(true);
  try {
    assert.throws(
      () =>
        storage.suggestionService.create({
          originThreadId: "thread-1",
          kind: "decision",
          content: "use sqlite",
          anchors: [],
        }),
      /anchors are required/
    );

    const suggestion = storage.suggestionService.create({
      originThreadId: "thread-1",
      kind: "decision",
      topic: "storage-primary",
      content: "在线读写以 SQLite 为准",
      confidence: 0.4,
      extractorVersion: "heuristic-v1",
      anchors: sampleAnchors(),
    });
    assert.equal(suggestion.status, "pending");
    assert.equal(suggestion.proposedScope, "project");
    assert.ok(suggestion.projectKey);

    // Pending suggestions never appear as active memory.
    const active = storage.memory.listActiveForTurn("thread-1");
    assert.ok(!active.some((m) => m.content.includes("SQLite")));

    const counts = storage.memoryEvents.countsForThread("thread-1");
    assert.ok(counts.memory_suggestion_created >= 1);
  } finally {
    storage.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("user accept promotes with authority=user and preserves extractor provenance", () => {
  const { storage, dir } = createFixture(true);
  try {
    const suggestion = storage.suggestionService.create({
      originThreadId: "thread-1",
      kind: "constraint",
      topic: "no-force-push",
      content: "禁止对 main force push",
      extractorVersion: "heuristic-v1",
      createdBy: "extractor:heuristic-v1",
      anchors: sampleAnchors(),
    });

    const outcome = storage.suggestionService.accept(suggestion.id, {
      reviewedBy: "user",
      reviewChannel: "user",
    });
    assert.equal(outcome.suggestion.status, "accepted");
    assert.equal(outcome.memory.status, "confirmed");
    assert.equal(outcome.memory.authority, "user");
    assert.equal(outcome.memory.createdBy, "extractor:heuristic-v1");
    assert.equal(outcome.memory.scope, "project");
    assert.equal(outcome.suggestion.promotedMemoryId, outcome.memory.id);

    const active = storage.memory.listActiveForTurn("thread-1");
    assert.ok(active.some((m) => m.id === outcome.memory.id));

    const events = storage.memoryEvents.listForThread("thread-1", { limit: 50 });
    assert.ok(events.some((e) => e.eventType === "memory_suggestion_accepted"));
    assert.ok(events.some((e) => e.eventType === "memory_confirmed"));
  } finally {
    storage.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agent cannot accept suggestions with user authority", () => {
  const { storage, dir } = createFixture(true);
  try {
    const suggestion = storage.suggestionService.create({
      originThreadId: "thread-1",
      kind: "fact",
      content: "port is 8787",
      anchors: sampleAnchors(),
      extractorVersion: "v1",
    });
    assert.throws(
      () =>
        storage.suggestionService.accept(suggestion.id, {
          reviewedBy: "agent:codex",
          reviewChannel: "agent",
        }),
      /Only user review/
    );
    assert.throws(
      () =>
        storage.suggestionService.accept(suggestion.id, {
          reviewedBy: "agent:codex",
          reviewChannel: "user",
        }),
      /cannot review/
    );
    assert.equal(storage.suggestions.get(suggestion.id).status, "pending");
  } finally {
    storage.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reject marks suggestion rejected and does not create memory", () => {
  const { storage, dir } = createFixture(true);
  try {
    const suggestion = storage.suggestionService.create({
      originThreadId: "thread-1",
      kind: "decision",
      topic: "reject-me",
      content: "bad decision candidate",
      anchors: sampleAnchors(),
      extractorVersion: "v1",
    });
    const rejected = storage.suggestionService.reject(suggestion.id, {
      reviewedBy: "user",
      reason: "not a real decision",
    });
    assert.equal(rejected.status, "rejected");
    assert.equal(storage.memory.listActiveForTurn("thread-1").length, 0);
    assert.ok(
      storage.memoryEvents.countsForThread("thread-1").memory_suggestion_rejected >= 1
    );
  } finally {
    storage.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cannot accept twice", () => {
  const { storage, dir } = createFixture(true);
  try {
    const suggestion = storage.suggestionService.create({
      originThreadId: "thread-1",
      kind: "decision",
      topic: "once",
      content: "only once",
      anchors: sampleAnchors(),
      extractorVersion: "v1",
    });
    storage.suggestionService.accept(suggestion.id, { reviewedBy: "user" });
    assert.throws(
      () => storage.suggestionService.accept(suggestion.id, { reviewedBy: "user" }),
      /Cannot accept suggestion/
    );
  } finally {
    storage.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("list includes project suggestions for sibling thread", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shift-sugg2-"));
  const storage = createStorage({ file: ":memory:" });
  try {
    storage.threads.create({ id: "thread-a", projectDir: dir });
    storage.threads.create({ id: "thread-b", projectDir: dir });
    storage.suggestionService.create({
      originThreadId: "thread-a",
      kind: "decision",
      topic: "shared-topic",
      content: "shared candidate",
      anchors: sampleAnchors("thread-a"),
      extractorVersion: "v1",
    });
    const listed = storage.suggestionService.list("thread-b", {
      includeProject: true,
      status: "pending",
    });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].originThreadId, "thread-a");
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("file anchors reject path traversal", () => {
  const { storage, dir } = createFixture(false);
  try {
    assert.throws(
      () =>
        storage.suggestionService.create({
          originThreadId: "thread-1",
          kind: "fact",
          content: "secret",
          anchors: [{ type: "file", ref: "../.env" }],
        }),
      /project-relative/
    );
  } finally {
    storage.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

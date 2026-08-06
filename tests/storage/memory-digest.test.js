const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const { buildHeuristicDigest, refreshDigest } = require("../../src/storage/memory-digest");

function createProjectFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shift-digest-"));
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "thread-a", projectDir: dir, title: "A" });
  storage.threads.create({ id: "thread-b", projectDir: dir, title: "B" });
  return { storage, dir };
}

test("heuristic digest only counts thread-scoped product memory", () => {
  const { storage, dir } = createProjectFixture();
  try {
    storage.memory.createProduct({
      threadId: "thread-b",
      kind: "fact",
      topic: "thread-local-topic",
      content: "only for thread b investigation note",
      createdBy: "user",
      writeChannel: "user",
    });

    const threadA = storage.threads.get("thread-a");
    storage.memories.create({
      id: "legacy-secret-project",
      scope: "project",
      projectKey: threadA.projectKey,
      originThreadId: "thread-a",
      kind: "decision",
      status: "active",
      topic: "secret-project-topic",
      content: "should never appear in sibling digest",
      captureKey: "legacy:secret-project-topic",
      supersessionKey: "decision:secret-project-topic",
      createdBy: "user",
      authority: "user",
      activation: "query",
    });

    const digestB = buildHeuristicDigest({ storage, threadId: "thread-b" });
    assert.match(digestB.summary, /活跃记忆:\s*1/);
    assert.ok(digestB.topics.includes("thread-local-topic"));
    assert.equal(digestB.topics.includes("secret-project-topic"), false);
    assert.doesNotMatch(digestB.summary, /secret-project-topic/);

    const digestA = buildHeuristicDigest({ storage, threadId: "thread-a" });
    assert.match(digestA.summary, /活跃记忆:\s*0/);
    assert.equal(digestA.topics.includes("secret-project-topic"), false);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("refreshDigest persists thread-only active memory counts", () => {
  const { storage, dir } = createProjectFixture();
  try {
    const threadA = storage.threads.get("thread-a");
    storage.memories.create({
      id: "legacy-project-in-refresh",
      scope: "project",
      projectKey: threadA.projectKey,
      originThreadId: "thread-a",
      kind: "constraint",
      status: "active",
      topic: "secret-project-topic",
      content: "project constraint must not leak into digest SSE payload",
      captureKey: "legacy:secret-refresh",
      supersessionKey: "constraint:secret-project-topic",
      createdBy: "user",
      authority: "user",
      activation: "query",
    });

    const { digest } = refreshDigest({ storage, threadId: "thread-b" });
    assert.ok(digest);
    assert.match(digest.summary, /活跃记忆:\s*0/);
    assert.equal((digest.topics || []).includes("secret-project-topic"), false);

    const stored = storage.digests.get("thread-b");
    assert.ok(stored);
    assert.equal((stored.topics || []).includes("secret-project-topic"), false);
    assert.match(stored.summary, /活跃记忆:\s*0/);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

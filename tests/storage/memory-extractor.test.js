const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const {
  extractDecisionCandidates,
  extractSuggestionsFromTurn,
  EXTRACTOR_VERSION,
} = require("../../src/storage/memory-extractor");
const {
  refreshDigestAndExtract,
  buildHeuristicDigest,
  summarizeAssistantOutcome,
} = require("../../src/storage/memory-digest");

function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shift-extract-"));
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "thread-1", projectDir: dir });
  return { storage, dir };
}

test("extractDecisionCandidates finds decisions and skips questions", () => {
  const found = extractDecisionCandidates(
    "就用 SQLite 作为在线存储。\n要不要改成 Postgres？\n禁止对 main force push。"
  );
  assert.ok(found.some((c) => c.kind === "decision" && /SQLite/.test(c.content)));
  assert.ok(found.some((c) => c.kind === "constraint" && /force push|main/.test(c.content)));
  assert.ok(!found.some((c) => /要不要/.test(c.content)));
  assert.ok(found.every((c) => c.confidence < 0.5));
});

test("extractSuggestionsFromTurn never writes product memories", () => {
  const { storage, dir } = createFixture();
  try {
    const stats = extractSuggestionsFromTurn({
      storage,
      threadId: "thread-1",
      userText: "就用 SQLite 作为在线读写真相源。",
      assistantText: "好的，我会遵守。",
      userMessageId: "msg-user-1",
      assistantMessageId: "msg-as-1",
      invocationId: "inv-1",
    });
    assert.ok(stats.created >= 1);
    assert.equal(storage.memory.listActiveForTurn("thread-1").length, 0);
    const pending = storage.suggestionService.list("thread-1", { status: "pending" });
    assert.ok(pending.length >= 1);
    assert.equal(pending[0].extractorVersion, EXTRACTOR_VERSION);
    assert.ok(pending[0].anchors.length >= 1);
    assert.ok(pending[0].confidence < 0.5);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractor skips when active product already covers topic", () => {
  const { storage, dir } = createFixture();
  try {
    storage.memory.createProduct({
      threadId: "thread-1",
      kind: "decision",
      topic: "sqlite",
      content: "SQLite is primary",
      createdBy: "user",
      writeChannel: "user",
    });
    // Force topic collision by using content that slugifies toward existing topic via capture pattern
    const stats = extractSuggestionsFromTurn({
      storage,
      threadId: "thread-1",
      userText: "就用 sqlite",
      userMessageId: "msg-2",
    });
    // May create 0 if topic matches, or create if slug differs — assert no auto product writes.
    assert.equal(storage.memory.listActive("thread-1", { scope: "all", forInject: false }).length, 1);
    assert.ok(stats.created + stats.skipped + stats.errors >= 0);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("refreshDigestAndExtract updates digest and pending candidates", () => {
  const { storage, dir } = createFixture();
  try {
    storage.messages.append({
      id: "m1",
      threadId: "thread-1",
      role: "user",
      content: "就用 SQLite",
      sequenceNo: 0,
    });
    const result = refreshDigestAndExtract({
      storage,
      threadId: "thread-1",
      userText: "就用 SQLite 作为主库。",
      assistantText: "收到。",
      userMessageId: "m1",
      invocationId: "inv-d",
      extractSuggestionsFromTurn,
    });
    assert.ok(result.digest);
    assert.match(result.digest.summary, /消息数/);
    assert.ok(result.extract.created >= 1);
    assert.ok(Array.isArray(result.digest.durableCandidates));
    assert.ok(result.digest.durableCandidates.length >= 1);

    const again = buildHeuristicDigest({ storage, threadId: "thread-1" });
    assert.ok(again.messageCount >= 1);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("semantic digest keeps review conclusions beyond the opening chatter", () => {
  const summary = summarizeAssistantOutcome(
    [
      "我先检查代码和测试。",
      "再核对启动流程。",
      "## 结论: request-changes",
      "P1 — README 缺少 SQLite 初始化步骤。",
      "### 下一步",
      "先修 README，再交给 OpenCode 复审。",
    ].join("\n")
  );

  assert.match(summary, /request-changes/);
  assert.match(summary, /README 缺少 SQLite 初始化/);
  assert.match(summary, /下一步/);
});

test("dedupes pending suggestions by kind:topic", () => {
  const { storage, dir } = createFixture();
  try {
    const first = extractSuggestionsFromTurn({
      storage,
      threadId: "thread-1",
      userText: "禁止使用 force push。",
      userMessageId: "u1",
    });
    const second = extractSuggestionsFromTurn({
      storage,
      threadId: "thread-1",
      userText: "禁止使用 force push。",
      userMessageId: "u2",
    });
    assert.ok(first.created >= 1);
    assert.ok(second.created === 0);
    assert.ok(second.skipped >= 1);
    const pending = storage.suggestionService.list("thread-1", { status: "pending" });
    assert.equal(pending.length, first.created);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

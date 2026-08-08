const assert = require("node:assert/strict");
const test = require("node:test");

const { eventPlainText } = require("../../src/storage/event-plain-text");

test("eventPlainText extracts text.delta body instead of JSON shell", () => {
  const plain = eventPlainText("text.delta", {
    text: "hello durable world",
    meta: { nested: true },
  });
  assert.equal(plain, "hello durable world");
  assert.doesNotMatch(plain, /"meta"/);
});

test("eventPlainText indexes commentary text for process recall", () => {
  assert.equal(
    eventPlainText("commentary.delta", { text: "investigating the provider stream" }),
    "investigating the provider stream"
  );
});

test("eventPlainText renders handoff summary fields", () => {
  const plain = eventPlainText("handoff", {
    to: "opencode",
    what: "实现登录",
    why: "需要鉴权",
    next_action: "写测试",
    files: ["src/auth.js"],
    ok: true,
  });
  assert.match(plain, /what: 实现登录/);
  assert.match(plain, /why: 需要鉴权/);
  assert.match(plain, /files: src\/auth\.js/);
  assert.doesNotMatch(plain, /\{"to"/);
});

test("eventPlainText summarizes tool events without dumping huge JSON", () => {
  const plain = eventPlainText("tool.result", {
    name: "bash",
    command: "npm test",
    output: "ok ".repeat(500),
  });
  assert.match(plain, /tool bash/);
  assert.match(plain, /npm test/);
  assert.ok(plain.length < 2000);
});

test("eventPlainText accepts payload_json strings", () => {
  const plain = eventPlainText("stderr", JSON.stringify({ text: "warn: disk full" }));
  assert.equal(plain, "warn: disk full");
});

test("eventPlainText renders usage fields for recall diagnostics", () => {
  const plain = eventPlainText("usage.update", {
    scope: "turn",
    inputTokens: 100,
    cachedInputTokens: 40,
    outputTokens: 20,
    reasoningTokens: 5,
    totalTokens: 120,
  });
  assert.match(plain, /usage turn/);
  assert.match(plain, /cached=40/);
  assert.match(plain, /total=120/);
});

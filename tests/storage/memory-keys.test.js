const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildSupersessionKey,
  buildProductCaptureKey,
  deriveTopicFromContent,
  normalizeProductKind,
  parseSupersessionKey,
  slugifyTopic,
} = require("../../src/storage/memory-keys");

test("product supersession keys are stable and kind-prefixed", () => {
  assert.equal(buildSupersessionKey("decision", "Storage Primary"), "decision:storage-primary");
  assert.equal(buildSupersessionKey("constraint", "chat fail open"), "constraint:chat-fail-open");
  assert.equal(buildSupersessionKey("fact", "runtime-database"), "fact:runtime-database");
  assert.throws(() => normalizeProductKind("handoff"), /Memory kind must be one of/);
});

test("topic slug keeps Chinese characters", () => {
  assert.equal(slugifyTopic("  存储主键  "), "存储主键");
  assert.equal(parseSupersessionKey("decision:存储主键").topic, "存储主键");
});

test("product capture keys are unique per write", () => {
  let n = 0;
  const a = buildProductCaptureKey("fact", "runtime", () => `id-${++n}`);
  const b = buildProductCaptureKey("fact", "runtime", () => `id-${++n}`);
  assert.match(a, /^product:fact:runtime:/);
  assert.notEqual(a, b);
  assert.equal(
    deriveTopicFromContent("Use SQLite as source of truth\nmore"),
    "use-sqlite-as-source-of-truth"
  );
});

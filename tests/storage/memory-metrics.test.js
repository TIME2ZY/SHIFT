const assert = require("node:assert/strict");
const test = require("node:test");

const {
  emptyWriteStats,
  mergeWriteStats,
  buildMemoryWriteMetrics,
  isMemoryMetricsLogEnabled,
  buildMemoryInjectPayload,
  slimInjectItems,
} = require("../../src/storage/memory-metrics");

test("mergeWriteStats adds numeric fields", () => {
  const merged = mergeWriteStats(
    { upsertCallback: 1, blockWritten: 2 },
    { blockParsed: 3, errors: 1 }
  );
  assert.equal(merged.upsertCallback, 1);
  assert.equal(merged.blockWritten, 2);
  assert.equal(merged.blockParsed, 3);
  assert.equal(merged.errors, 1);
  assert.equal(merged.invalidateCallback, 0);
});

test("buildMemoryWriteMetrics totals writes", () => {
  const metrics = buildMemoryWriteMetrics({
    source: "chat",
    agent: "codex",
    stats: { upsertCallback: 1, blockWritten: 2, blockParsed: 2 },
  });
  assert.equal(metrics.kind, "memory_write");
  assert.equal(metrics.totalWrites, 3);
  assert.equal(metrics.agent, "codex");
});

test("isMemoryMetricsLogEnabled reads SHIFT_MEMORY_METRICS_LOG", () => {
  assert.equal(isMemoryMetricsLogEnabled({}), false);
  assert.equal(isMemoryMetricsLogEnabled({ SHIFT_MEMORY_METRICS_LOG: "1" }), true);
  assert.equal(isMemoryMetricsLogEnabled({ SHIFT_MEMORY_METRICS_LOG: "false" }), false);
});

test("slimInjectItems truncates content", () => {
  const items = slimInjectItems([
    { id: "m1", kind: "decision", content: "x".repeat(200), status: "captured" },
  ]);
  assert.equal(items[0].content.length, 120);
  assert.equal(items[0].id, "m1");
});

test("buildMemoryInjectPayload shapes UI payload", () => {
  const payload = buildMemoryInjectPayload({
    sessionId: "s1",
    agent: "codex",
    source: "bootstrap",
    items: [{ id: "m1", kind: "fact", content: "port 8787" }],
    stats: { usedChars: 10, byKind: { fact: 1 } },
  });
  assert.equal(payload.count, 1);
  assert.equal(payload.sessionId, "s1");
  assert.equal(payload.items[0].kind, "fact");
  assert.equal(payload.availability.state, "available");
  assert.deepEqual(emptyWriteStats().upsertCallback, 0);
});

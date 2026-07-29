const assert = require("node:assert/strict");
const test = require("node:test");

const {
  analyzeMemoryStabilization,
  memorySlot,
} = require("../../src/storage/memory-stabilization");

function product(overrides = {}) {
  return {
    id: "memory-1",
    scope: "thread",
    ownerThreadId: "thread-1",
    kind: "decision",
    status: "captured",
    topic: "storage.authoritative",
    content: "SQLite is authoritative.",
    anchors: [{ type: "message", ref: "message-1" }],
    ...overrides,
  };
}

test("stabilization audit separates product memory from recovery records", () => {
  const report = analyzeMemoryStabilization([
    product(),
    product({ id: "handoff-1", kind: "handoff", topic: null, anchors: [] }),
    product({ id: "old-1", status: "superseded" }),
  ]);
  assert.equal(report.readyForRetrieval, true);
  assert.deepEqual(report.retrievable, ["memory-1"]);
  assert.deepEqual(report.logicallyIsolated, ["handoff-1"]);
  assert.deepEqual(report.retiredProducts, ["old-1"]);
});

test("stabilization audit reports missing evidence and active slot conflicts", () => {
  const report = analyzeMemoryStabilization([
    product({ id: "memory-1", anchors: [] }),
    product({ id: "memory-2" }),
  ]);
  assert.equal(report.readyForRetrieval, false);
  assert.deepEqual(report.qualityReview, [
    { memoryId: "memory-1", issues: ["missing_evidence"] },
  ]);
  assert.deepEqual(report.conflicts, [
    {
      slot: "thread:thread-1:storage.authoritative",
      memoryIds: ["memory-1", "memory-2"],
    },
  ]);
});

test("memory slots exclude incomplete ownership", () => {
  assert.equal(memorySlot(product()), "thread:thread-1:storage.authoritative");
  assert.equal(
    memorySlot(
      product({
        scope: "project",
        ownerThreadId: null,
        projectKey: "project-1",
      })
    ),
    "project:project-1:storage.authoritative"
  );
  assert.equal(memorySlot(product({ topic: null, supersessionKey: null })), null);
});

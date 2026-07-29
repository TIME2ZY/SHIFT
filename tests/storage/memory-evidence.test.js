const assert = require("node:assert/strict");
const test = require("node:test");

const {
  describeMemoryEvidenceEvent,
  isSuccessfulMemoryEvidenceEvent,
} = require("../../src/storage/memory-evidence");

test("memory evidence accepts only successful completed tool events", () => {
  assert.equal(
    isSuccessfulMemoryEvidenceEvent({
      kind: "tool.finished",
      payload: { status: "ok" },
    }),
    true
  );
  assert.equal(
    isSuccessfulMemoryEvidenceEvent({
      kind: "tool.finished",
      payload: { exitCode: 1 },
    }),
    false
  );
  assert.equal(
    isSuccessfulMemoryEvidenceEvent({
      kind: "text.delta",
      payload: { text: "not evidence" },
    }),
    false
  );
});

test("memory evidence descriptors expose a bounded snapshot and event number", () => {
  const descriptor = describeMemoryEvidenceEvent({
    sequenceNo: 9,
    kind: "tool.finished",
    payload: { toolName: "tests", result: "x".repeat(400), status: "ok" },
    createdAt: "2026-07-29T00:00:00.000Z",
  });
  assert.equal(descriptor.eventNo, 9);
  assert.equal(descriptor.kind, "tool.finished");
  assert.ok(descriptor.summary.length <= 240);
  assert.equal(descriptor.createdAt, "2026-07-29T00:00:00.000Z");
});

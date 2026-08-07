const assert = require("node:assert/strict");
const test = require("node:test");

const {
  evaluateMemoryWriteGate,
  evaluateMemoryWritePredictions,
} = require("../../src/storage/offline/memory-write-eval");

const CASES = [
  {
    id: "write-decision",
    expected: {
      shouldWrite: true,
      kind: "decision",
      scope: "thread",
      topic: "storage.authoritative",
    },
  },
  { id: "skip-progress", expected: { shouldWrite: false } },
  { id: "skip-question", expected: { shouldWrite: false } },
];

test("memory write eval calculates precision and semantic field accuracy", () => {
  const report = evaluateMemoryWritePredictions(CASES, [
    {
      id: "write-decision",
      shouldWrite: true,
      kind: "decision",
      scope: "thread",
      topic: "storage.authoritative",
      atomic: true,
    },
    { id: "skip-progress", shouldWrite: true },
    { id: "skip-question", shouldWrite: false },
  ]);
  assert.deepEqual(report.counts, {
    cases: 3,
    predictions: 3,
    evaluated: 3,
    missing: 0,
    tp: 1,
    fp: 1,
    fn: 0,
    tn: 1,
  });
  assert.equal(report.metrics.writePrecision, 0.5);
  assert.equal(report.metrics.writeRecall, 1);
  assert.equal(report.metrics.kindAccuracy, 1);
});

test("memory write eval gate prioritizes precision and complete coverage", () => {
  const report = evaluateMemoryWritePredictions(CASES, [
    {
      id: "write-decision",
      shouldWrite: true,
      kind: "decision",
      scope: "thread",
      topic: "storage.authoritative",
    },
    { id: "skip-progress", shouldWrite: false },
  ]);
  const gate = evaluateMemoryWriteGate(report);
  assert.equal(gate.passed, false);
  assert.ok(gate.failed.some((item) => item.metric === "coverage"));
});

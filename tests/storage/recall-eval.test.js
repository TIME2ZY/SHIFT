const assert = require("node:assert/strict");
const test = require("node:test");
const {
  evaluateRecallCases,
  evaluateRecallGate,
} = require("../../src/storage/recall-eval");

test("recall eval calculates ranking and security metrics", () => {
  const cases = [
    {
      id: "hit",
      expected: ["memory-good"],
      forbidden: ["memory-other"],
      expectedChannel: "exact-topic",
    },
  ];
  const results = [
    {
      id: "hit",
      hits: [
        {
          source: { memoryId: "memory-good" },
          matchedBy: ["exact-topic"],
          metadata: { status: "captured" },
        },
      ],
    },
  ];
  const report = evaluateRecallCases(cases, results, { limit: 10 });
  assert.equal(report.metrics.recallAtK, 1);
  assert.equal(report.metrics.mrr, 1);
  assert.equal(report.metrics.scopeLeakageRate, 0);
  assert.equal(report.metrics.supersededRecallRate, 0);
  assert.equal(report.metrics.channelAccuracy, 1);
  assert.equal(evaluateRecallGate(report).passed, true);
});

test("recall eval gate rejects leakage and retired results", () => {
  const cases = [
    {
      id: "leak",
      expected: ["memory-good"],
      forbidden: ["memory-other"],
    },
  ];
  const results = [
    {
      id: "leak",
      hits: [
        {
          source: { memoryId: "memory-other" },
          matchedBy: ["fts"],
          metadata: { status: "superseded" },
        },
      ],
    },
  ];
  const report = evaluateRecallCases(cases, results);
  const gate = evaluateRecallGate(report);
  assert.equal(gate.passed, false);
  assert.ok(gate.failed.some((item) => item.metric === "scopeLeakageRate"));
  assert.ok(gate.failed.some((item) => item.metric === "supersededRecallRate"));
});

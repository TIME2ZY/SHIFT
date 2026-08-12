const assert = require("node:assert/strict");
const test = require("node:test");
const {
  evaluateRecallCases,
  evaluateRecallGate,
  normalizedDcg,
  validateLabeledRecallDataset,
} = require("../../src/storage/offline/labeled-recall-eval");

test("recall eval calculates ranking and security metrics", () => {
  const cases = [
    {
      id: "hit",
      relevance: { "memory-good": 3, "memory-ok": 1 },
      forbidden: ["memory-other"],
      expectedChannel: "exact-topic",
      businessOutcome: { label: "success", evidence: "reviewed task completion" },
    },
  ];
  const results = [
    {
      id: "hit",
      hits: [
        {
          source: { memoryId: "memory-good" },
          matchedBy: ["exact-topic"],
          metadata: { status: "active" },
        },
        {
          source: { memoryId: "memory-ok" },
          matchedBy: ["fts"],
          metadata: { status: "active" },
        },
      ],
    },
  ];
  const report = evaluateRecallCases(cases, results, { limit: 10 });
  assert.equal(report.metrics.recallAtK, 1);
  assert.equal(report.metrics.mrr, 1);
  assert.equal(report.metrics.ndcgAtK, 1);
  assert.equal(report.metrics.scopeLeakageRate, 0);
  assert.equal(report.metrics.supersededRecallRate, 0);
  assert.equal(report.metrics.channelAccuracy, 1);
  assert.equal(report.metrics.businessOutcome.retrievalSupportedRate, 1);
  assert.equal(evaluateRecallGate(report).passed, true);
});

test("recall eval gate rejects leakage and retired results", () => {
  const cases = [
    {
      id: "leak",
      relevance: { "memory-good": 3 },
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

test("labeled recall dataset requires graded relevance and outcome evidence", () => {
  const queries = validateLabeledRecallDataset({
    version: 2,
    queries: [
      {
        id: "graded",
        query: "storage authority",
        relevance: { "memory-best": 3, "memory-related": 1 },
        businessOutcome: { label: "success", evidence: "accepted by evaluator-1" },
      },
    ],
  });
  assert.equal(queries.length, 1);
  assert.equal(normalizedDcg(["memory-related", "memory-best"], queries[0].relevance, 2) < 1, true);
  assert.throws(
    () =>
      validateLabeledRecallDataset({
        version: 2,
        queries: [{ id: "bad", query: "ok", relevance: {}, businessOutcome: { label: "success" } }],
      }),
    /evidence/
  );
});

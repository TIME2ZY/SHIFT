"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { validateReport, validateReview } = require("../../src/tasks/materials-report");
const inputs = [
  { id: "source", name: "source.md", contentHash: "a".repeat(64), lines: ["hello", "facts"] },
];
const output = (value) => "```materials_report\n" + JSON.stringify(value) + "\n```";
const report = {
  title: "Report",
  sections: [
    {
      heading: "Findings",
      claims: [
        {
          text: "Fact",
          citations: [{ inputId: "source", startLine: 2, endLine: 2, quote: "facts" }],
        },
      ],
    },
  ],
};
test("all claims retain verified frozen source lines in deterministic reviewed Markdown", () => {
  const result = validateReport(output(report), inputs);
  assert.match(result.markdown, /source.md · L2–L2/);
  assert.match(result.markdown, /> facts/);
  assert.equal(result.sourceChecks[0].verified, true);
  assert.equal(result.sourceChecks[0].contentHash, inputs[0].contentHash);
  for (const patch of [
    { inputId: "missing" },
    { startLine: 0 },
    { endLine: 3 },
    { quote: "invented" },
  ]) {
    const bad = structuredClone(report);
    Object.assign(bad.sections[0].claims[0].citations[0], patch);
    assert.throws(() => validateReport(output(bad), inputs), { code: "INVALID_MATERIALS_REPORT" });
  }
  const noSource = structuredClone(report);
  noSource.sections[0].claims[0].citations = [];
  assert.throws(() => validateReport(output(noSource), inputs), {
    code: "INVALID_MATERIALS_REPORT",
  });
  assert.throws(() => validateReport(output(report) + "\n" + output(report), inputs), {
    code: "INVALID_MATERIALS_REPORT",
  });
});
test("review requires complete criteria and no unresolved accepted findings", () => {
  const wrap = (value) => "```materials_review\n" + JSON.stringify(value) + "\n```";
  const review = {
    verdict: "accepted",
    criteria: ["accurate"],
    findings: [],
    summary: "supported",
  };
  assert.equal(validateReview(wrap(review), ["accurate"]).verdict, "accepted");
  for (const patch of [{ criteria: [] }, { findings: ["unresolved"] }, { verdict: "maybe" }])
    assert.throws(() => validateReview(wrap({ ...review, ...patch }), ["accurate"]), {
      code: "INVALID_MATERIALS_REPORT",
    });
});

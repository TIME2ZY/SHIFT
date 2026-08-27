/**
 * Deterministic tests for the live issue-fix assertion helpers.
 * No real CLI, no network — these pin the acceptance semantics.
 */
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  evaluatePreflightRed,
  evaluateResolution,
  evaluateChangedFiles,
  evaluateChatOutcome,
  evaluatePersistence,
  evaluateTrace,
  buildIssuePrompt,
} = require("../../scripts/live/lib/assertions");

function jestJson(assertions) {
  return {
    testResults: [
      {
        status: "failed",
        assertionResults: assertions.map(([fullName, title, status]) => ({
          fullName,
          title,
          status,
        })),
      },
    ],
  };
}

test("preflight red requires exactly the F2P tests to fail", () => {
  const json = jestJson([
    ["existing green test", "existing green test", "passed"],
    ["Creating should handle floating point rounding errors", "should handle floating point rounding errors", "failed"],
  ]);
  const ok = evaluatePreflightRed(json, ["should handle floating point rounding errors"]);
  assert.equal(ok.ok, true);

  const notRed = evaluatePreflightRed(
    jestJson([
      ["existing green test", "existing green test", "passed"],
      ["should handle floating point rounding errors", "should handle floating point rounding errors", "passed"],
    ]),
    ["should handle floating point rounding errors"]
  );
  assert.equal(notRed.ok, false);
  assert.match(notRed.problems.join("; "), /not red/);
});

test("preflight red rejects instances with unrelated failures at base", () => {
  const json = jestJson([
    ["test a", "test a", "passed"],
    ["unrelated breakage", "unrelated breakage", "failed"],
    ["should handle floating point rounding errors", "should handle floating point rounding errors", "failed"],
  ]);
  const result = evaluatePreflightRed(json, ["should handle floating point rounding errors"]);
  assert.equal(result.ok, false);
  assert.match(result.problems.join("; "), /non-F2P/);
});

test("preflight red rejects empty jest results (suite-level crash)", () => {
  const result = evaluatePreflightRed({ testResults: [{ status: "failed" }] }, ["x"]);
  assert.equal(result.ok, false);
  assert.match(result.problems.join("; "), /no per-test results/);
});

test("resolution requires F2P green and no regressions", () => {
  const green = jestJson([
    ["existing green test", "existing green test", "passed"],
    ["Creating should handle floating point rounding errors", "should handle floating point rounding errors", "passed"],
  ]);
  assert.equal(evaluateResolution(green, ["should handle floating point rounding errors"]).ok, true);

  const stillRed = jestJson([
    ["existing green test", "existing green test", "passed"],
    ["should handle floating point rounding errors", "should handle floating point rounding errors", "failed"],
  ]);
  assert.equal(evaluateResolution(stillRed, ["should handle floating point rounding errors"]).ok, false);

  const regression = jestJson([
    ["existing green test", "existing green test", "failed"],
    ["should handle floating point rounding errors", "should handle floating point rounding errors", "passed"],
  ]);
  const regressionResult = evaluateResolution(regression, ["should handle floating point rounding errors"]);
  assert.equal(regressionResult.ok, false);
  assert.match(regressionResult.problems.join("; "), /regressions/);
});

test("F2P names match by title or fullName suffix", () => {
  const json = jestJson([["Describe block cloning dates modified with utcOffset", "cloning dates modified with utcOffset", "failed"]]);
  assert.equal(evaluatePreflightRed(json, ["cloning dates modified with utcOffset"]).ok, true);
});

test("changed files must stay inside allowed source prefixes", () => {
  const ok = evaluateChangedFiles(["src/plugin/utc/index.js"], ["src/"]);
  assert.equal(ok.ok, true);

  const violation = evaluateChangedFiles(["src/plugin/utc/index.js", "test/plugin/utc.test.js"], ["src/"]);
  assert.equal(violation.ok, false);
  assert.deepEqual(violation.violations, ["test/plugin/utc.test.js"]);
});

test("chat outcome requires exit 0, non-empty answer, completed invocation", () => {
  assert.equal(
    evaluateChatOutcome({ exitCode: 0, assistantText: "fixed", invocationState: "completed", sseError: "" }).ok,
    true
  );
  const bad = evaluateChatOutcome({ exitCode: 1, assistantText: "", invocationState: "failed", sseError: "" });
  assert.equal(bad.ok, false);
  assert.equal(bad.problems.length, 3);
  const noInvocation = evaluateChatOutcome({ exitCode: 0, assistantText: "x", invocationState: "", sseError: "boom" });
  assert.equal(noInvocation.ok, false);
  assert.match(noInvocation.problems.join("; "), /error/);
});

test("persistence requires user message and non-empty assistant-final", () => {
  const ok = evaluatePersistence(
    [
      { role: "user", text: "# UTC plugin: getting incorrect clone" },
      { role: "assistant", messageType: "assistant-final", text: "The fix is applied." },
    ],
    { expectedUserTextPrefix: "# UTC plugin: getting incorrect clone" }
  );
  assert.equal(ok.ok, true);

  const empty = evaluatePersistence([{ role: "user", text: "# UTC plugin: getting incorrect clone" }], {
    expectedUserTextPrefix: "# UTC plugin",
  });
  assert.equal(empty.ok, false);
  assert.match(empty.problems.join("; "), /assistant-final/);

  const wrongPrompt = evaluatePersistence(
    [{ role: "user", text: "unrelated" }, { role: "assistant", messageType: "assistant-final", text: "hi" }],
    { expectedUserTextPrefix: "# UTC plugin: getting incorrect clone" }
  );
  assert.equal(wrongPrompt.ok, false);
  assert.match(wrongPrompt.problems.join("; "), /user message/);
});

test("trace must be terminal with a completed invocation", () => {
  assert.equal(
    evaluateTrace({ state: "completed", invocations: [{ invocationId: "i1", state: "completed" }] }).ok,
    true
  );
  const active = evaluateTrace({ state: "active", invocations: [{ invocationId: "i1", state: "active" }] });
  assert.equal(active.ok, false);
  assert.match(active.problems.join("; "), /not terminal/);
  const failed = evaluateTrace({ state: "failed", invocations: [{ invocationId: "i1", state: "failed" }] });
  assert.equal(failed.ok, false);
  assert.equal(evaluateTrace(null).ok, false);
});

test("issue prompt embeds the issue and source-only constraints", () => {
  const prompt = buildIssuePrompt("# Some bug\n\nrepro here");
  assert.match(prompt, /^# Some bug/);
  assert.match(prompt, /Do not modify any files under test\//);
  assert.match(prompt, /leave your changes in the working tree/);
});

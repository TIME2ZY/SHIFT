const assert = require("node:assert/strict");
const test = require("node:test");
const {
  evaluateObservabilitySnapshot,
  compareRestartSnapshots,
} = require("../../scripts/live/lib/observability-audit");

function healthySnapshot() {
  return {
    traces: [
      {
        traceId: "trace-1",
        state: "completed",
        invocations: [
          {
            invocationId: "source-1",
            state: "completed",
            outcome: { terminalReason: "assistant-final" },
          },
          {
            invocationId: "target-1",
            state: "completed",
            outcome: { terminalReason: "assistant-final" },
          },
        ],
        handoffs: [
          {
            handoffId: "h1",
            routeStatus: "accepted",
            receiveStatus: "started",
            completeStatus: "completed",
            targetInvocationId: "target-1",
          },
        ],
      },
    ],
    health: { storage: { observability: { state: "available", authoritativeViolations: 0 } } },
    expectedInvocationIds: ["source-1", "target-1"],
    requireHandoff: true,
  };
}

test("live observability audit aligns SSE causality with durable terminal state", () => {
  const report = evaluateObservabilitySnapshot(healthySnapshot());
  assert.equal(report.passed, true);
  assert.deepEqual(report.acceptedHandoffIds, ["h1"]);
});

test("live observability audit fails active traces and incomplete handoffs", () => {
  const input = healthySnapshot();
  input.traces[0].state = "active";
  input.traces[0].handoffs[0].completeStatus = "pending";
  const report = evaluateObservabilitySnapshot(input);
  assert.equal(report.passed, false);
  assert.ok(report.assertions.some((item) => item.id === "O2-NO-ACTIVE" && !item.ok));
  assert.ok(report.assertions.some((item) => item.id === "O5-HANDOFF-DURABLE" && !item.ok));
});

test("restart comparison fails when durable coordinates disappear", () => {
  const before = evaluateObservabilitySnapshot(healthySnapshot());
  const afterInput = healthySnapshot();
  afterInput.traces[0].invocations.pop();
  afterInput.expectedInvocationIds = ["source-1"];
  afterInput.requireHandoff = false;
  const after = evaluateObservabilitySnapshot(afterInput);
  const restart = compareRestartSnapshots(before, after);
  assert.equal(restart.passed, false);
  assert.ok(restart.assertions.some((item) => item.id === "O8-RESTART-INVOCATIONS" && !item.ok));
});

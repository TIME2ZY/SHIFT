const assert = require("node:assert/strict");
const test = require("node:test");
const {
  evaluateObservabilitySnapshot,
  compareRestartSnapshots,
  localizeFailure,
  evaluatePhase3Release,
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

test("phase three release gate requires trend alerts and redacted exporter delivery", () => {
  const report = evaluatePhase3Release({
    metrics: {
      comparison: {
        indicators: [{ metric: "handoff.completion" }, { metric: "memory.searchHitRate" }],
      },
    },
    health: {
      observability: { alerts: [] },
      observabilityExporter: { enabled: true, state: "idle" },
    },
    exportRequests: [
      {
        json: {
          snapshot: {
            schema: "shift-observability-snapshot-v1",
            health: { state: "available" },
            metrics: { handoffCompletion: { value: 1 } },
          },
        },
      },
    ],
  });
  assert.equal(report.passed, true);
});

test("phase three release gate rejects sensitive exporter fields", () => {
  const report = evaluatePhase3Release({
    metrics: { comparison: { indicators: [{}, {}] } },
    health: {
      observability: { alerts: [] },
      observabilityExporter: { enabled: true },
    },
    exportRequests: [
      {
        json: {
          snapshot: { schema: "shift-observability-snapshot-v1", prompt: "secret" },
        },
      },
    ],
  });
  assert.equal(report.passed, false);
  assert.ok(report.assertions.some((item) => item.id === "P3-EXPORT-REDACTED" && !item.ok));
});

test("failure localization prefers incomplete spans then handoff and invocation coordinates", () => {
  assert.deepEqual(
    localizeFailure({
      traceId: "trace-1",
      state: "failed",
      invocations: [{ invocationId: "inv-1", state: "failed", outcome: { errorCode: "exit_7" } }],
      handoffs: [],
      spans: [{ spanId: "tool-1", invocationId: "inv-1", kind: "tool", complete: false }],
    }),
    {
      errorCode: "span_missing_end",
      failureStage: "tool",
      invocationId: "inv-1",
      coordinateId: "tool-1",
    }
  );
  assert.equal(
    localizeFailure({
      traceId: "trace-2",
      state: "failed",
      invocations: [],
      handoffs: [
        {
          handoffId: "handoff-1",
          sourceInvocationId: "source-1",
          targetInvocationId: null,
          routeStatus: "accepted",
          receiveStatus: "not_started",
          completeStatus: "failed",
          outcome: {},
        },
      ],
    }).errorCode,
    "handoff_not_started"
  );
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

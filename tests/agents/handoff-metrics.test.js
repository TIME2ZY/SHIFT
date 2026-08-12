const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildFinalizeMetrics,
  formatFinalizeMetricsLine,
  memoryCardHasActiveItems,
  buildA2AInjectMetrics,
  formatA2AInjectMetricsLine,
  isHandoffMetricsLogEnabled,
  logFinalizeMetrics,
} = require("../../src/agents/handoff-metrics");
const { finalizeA2ARoutes } = require("../../src/agents/a2a-finalize");
const { DECISIONS } = require("../../src/agents/handoff-policy");

test("buildFinalizeMetrics returns null without mentions", () => {
  assert.equal(buildFinalizeMetrics({ mentions: [] }), null);
});

test("buildFinalizeMetrics computes rates for mixed outcomes", () => {
  const metrics = buildFinalizeMetrics({
    source: "chat",
    mode: "balanced",
    threadId: "t1",
    invocationId: "inv1",
    mentions: ["opencode", "grok"],
    enqueued: [{ to: "opencode" }],
    repairs: [{ to: "grok" }],
    skipped: [],
    handoffQualityByTarget: {
      opencode: {
        ok: true,
        degraded: false,
        emptyPacket: false,
        hasBlock: true,
        toMismatch: false,
      },
      grok: { ok: false, degraded: true, emptyPacket: true, hasBlock: false, toMismatch: false },
    },
    capturedCount: 1,
  });
  assert.equal(metrics.targets, 2);
  assert.equal(metrics.enqueued, 1);
  assert.equal(metrics.repairs, 1);
  assert.equal(metrics.ok, 1);
  assert.equal(metrics.degraded, 1);
  assert.equal(metrics.empty, 1);
  assert.equal(metrics.hasBlock, 1);
  assert.equal(metrics.captured, 1);
  assert.equal(metrics.ok_rate, 0.5);
  assert.equal(metrics.degraded_rate, 0.5);
  assert.equal(metrics.repair_rate, 0.5);
  assert.equal(metrics.capture_rate, 1);
  const line = formatFinalizeMetricsLine(metrics);
  assert.match(line, /\[handoff-metrics\]/);
  assert.match(line, /degraded_rate=0\.5/);
  assert.match(line, /repair_rate=0\.5/);
  assert.match(line, /capture_rate=1/);
  assert.match(line, /thread=t1/);
});

test("memoryCardHasActiveItems detects empty and non-empty cards", () => {
  assert.equal(memoryCardHasActiveItems(""), false);
  assert.equal(memoryCardHasActiveItems("<!-- Active Memories (0) -->\n尚无结构化记忆"), false);
  assert.equal(
    memoryCardHasActiveItems("<!-- Active Memories (1) -->\n1. [active][handoff] id=m1\ncontent"),
    true
  );
});

test("buildA2AInjectMetrics flags a2a_prompt_has_memory", () => {
  const empty = buildA2AInjectMetrics({
    agent: "opencode",
    memoryCard: "<!-- Active Memories (0) -->",
    promptBytes: 100,
  });
  assert.equal(empty.a2a_prompt_has_memory, 0);
  const full = buildA2AInjectMetrics({
    agent: "opencode",
    memoryCard: "<!-- Active Memories (2) -->\n[active]",
    promptBytes: 5000,
  });
  assert.equal(full.a2a_prompt_has_memory, 1);
  assert.equal(full.prompt_bytes, 5000);
  assert.match(formatA2AInjectMetricsLine(full), /a2a_prompt_has_memory=1/);
});

test("finalizeA2ARoutes keeps terminal metrics silent and returns SSE metrics", () => {
  const lines = [];
  const events = [];
  const result = finalizeA2ARoutes({
    text: [
      "@OpenCode continue",
      "```handoff",
      "to: opencode",
      "what: implement feature",
      "why: product need",
      "next_action: write code",
      "```",
    ].join("\n"),
    fromAgent: "codex",
    threadId: "t-metrics",
    sessionId: "t-metrics",
    invocationId: "inv-metrics",
    worklist: ["codex"],
    a2aCount: 0,
    policyMode: "balanced",
    memoryCapture: {
      captureHandoff() {
        return { captured: true, event: { id: "m1" } };
      },
    },
    sendSse: (kind, payload) => events.push({ kind, payload }),
    logger: { info: (line) => lines.push(line) },
    agentLabels: { codex: "Codex", opencode: "OpenCode" },
    durableRecorder: {
      acceptHandoff: (input) => ({
        accepted: true,
        status: "accepted",
        record: {
          handoffId: "h-metrics",
          routeStatus: "accepted",
          completeStatus: "pending",
          depth: input.depth,
        },
      }),
      markHandoffEnqueued: (handoffId) => ({ handoffId, enqueuedAt: new Date().toISOString() }),
    },
  });

  assert.ok(result.metrics);
  assert.equal(result.metrics.targets, 1);
  assert.equal(result.metrics.captured, 1);
  assert.equal(result.metrics.capture_rate, 1);
  assert.equal(result.metrics.ok_rate, 1);
  assert.equal(result.enqueued.length, 1);
  assert.deepEqual(lines, []);
  assert.ok(events.some((e) => e.kind === "handoff-metrics" && e.payload.kind === "finalize"));
});

test("finalizeA2ARoutes repair path reports repair_rate=1", () => {
  const lines = [];
  const result = finalizeA2ARoutes({
    text: "@OpenCode\nplease implement without fence",
    fromAgent: "codex",
    threadId: "t-repair",
    sessionId: "t-repair",
    invocationId: "inv-repair",
    worklist: ["codex"],
    a2aCount: 0,
    useWorktree: true,
    policyMode: "balanced",
    logger: { info: (line) => lines.push(line) },
    agentLabels: { codex: "Codex", opencode: "OpenCode" },
  });
  assert.equal(result.repairs.length, 1);
  assert.equal(result.metrics.repair_rate, 1);
  assert.equal(result.metrics.enqueued, 0);
  assert.equal(result.repairs[0].policy, DECISIONS.REQUEST_REPAIR);
  assert.deepEqual(lines, []);
});

test("logFinalizeMetrics is a no-op for null metrics", () => {
  const lines = [];
  logFinalizeMetrics(null, { info: (line) => lines.push(line) });
  assert.deepEqual(lines, []);
});

test("handoff terminal metrics are opt-in", () => {
  const metrics = buildFinalizeMetrics({
    mentions: ["opencode"],
    enqueued: [{ to: "opencode" }],
    handoffQualityByTarget: { opencode: { ok: true, hasBlock: true } },
  });
  const lines = [];
  const logger = { info: (line) => lines.push(line) };

  assert.equal(isHandoffMetricsLogEnabled({}), false);
  logFinalizeMetrics(metrics, logger, {});
  assert.deepEqual(lines, []);

  assert.equal(isHandoffMetricsLogEnabled({ SHIFT_HANDOFF_METRICS_LOG: "true" }), true);
  logFinalizeMetrics(metrics, logger, { SHIFT_HANDOFF_METRICS_LOG: "1" });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[handoff-metrics\].*kind=finalize/);
});

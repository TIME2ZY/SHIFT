const assert = require("node:assert/strict");
const test = require("node:test");

const {
  auditInvocationLifecycle,
  aggregateInvocationAudits,
} = require("../../scripts/live/lib/invocation-audit");
const {
  buildTurnTrace,
  aggregateTrace,
} = require("../../scripts/live/lib/multi-trace");
const { auditHandoffs } = require("../../scripts/live/lib/handoff-audit");
const { evaluateMultiCollab } = require("../../scripts/live/lib/multi-assert");
const { renderReportMd } = require("../../scripts/live/lib/live-dump");
const {
  auditMemoryRetrieval,
} = require("../../scripts/live/lib/memory-retrieval-audit");

function event(eventName, data) {
  return { event: eventName, data };
}

function closedTurn({ turnId, phaseId, agents }) {
  const events = [];
  for (const [index, agent] of agents.entries()) {
    const invocationId = `${turnId}-${agent}-${index}`;
    events.push(event("agent-start", { agent, invocationId }));
    events.push(event("agent-exit", { agent, invocationId, code: 0, signal: null }));
  }
  events.push(event("message", { role: "assistant", text: `${turnId} complete` }));
  events.push(event("done", {}));
  return buildTurnTrace(events, {
    turnId,
    phaseId,
    status: 200,
    ok: true,
  });
}

function routedTurn({ turnId, phaseId, from, to, duplicate = false }) {
  const parentInvocationId = `${turnId}-${from}`;
  const targetInvocationId = `${turnId}-${to}`;
  const routeMessageId = `${turnId}-route`;
  const events = [
    event("agent-start", {
      agent: from,
      invocationId: parentInvocationId,
    }),
    event("window-meta", {
      agent: from,
      invocationId: parentInvocationId,
      parentInvocationId: null,
      triggerMessageId: `${turnId}-user`,
      triggerType: "user-message",
    }),
    event("agent-exit", {
      agent: from,
      invocationId: parentInvocationId,
      code: 0,
      signal: null,
    }),
    event("handoff-parsed", {
      from,
      to,
      ok: true,
    }),
    event("a2a-route", {
      handoffId: `${parentInvocationId}:${to}:1`,
      from,
      to,
      parentInvocationId,
      routeMessageId,
      handoffOk: true,
    }),
  ];
  if (duplicate) {
    events.push(
      event("handoff-parsed", { from, to, ok: true }),
      event("a2a-route", {
        handoffId: `${parentInvocationId}:${to}:2`,
        from,
        to,
        parentInvocationId,
        routeMessageId: `${routeMessageId}-duplicate`,
        handoffOk: true,
      })
    );
  }
  events.push(
    event("agent-start", {
      agent: to,
      invocationId: targetInvocationId,
    }),
    event("window-meta", {
      agent: to,
      invocationId: targetInvocationId,
      parentInvocationId,
      triggerMessageId: routeMessageId,
      triggerType: "a2a-handoff",
    }),
    event("agent-exit", {
      agent: to,
      invocationId: targetInvocationId,
      code: 0,
      signal: null,
    }),
    event("message", { role: "assistant", text: `${turnId} complete` }),
    event("done", {})
  );
  return buildTurnTrace(events, {
    turnId,
    phaseId,
    status: 200,
    ok: true,
  });
}

test("invocation audit flags a started invocation without agent-exit", () => {
  const result = auditInvocationLifecycle(
    [{ agent: "codex", invocationId: "inv-1" }],
    []
  );
  assert.equal(result.lifecycleClosed, false);
  assert.deepEqual(result.orphanInvocationIds, ["inv-1"]);
  assert.deepEqual(result.violations, [
    { invocationId: "inv-1", code: "missing-agent-exit" },
  ]);
});

test("buildTurnTrace preserves lifecycle failures independently of HTTP and assistant text", () => {
  const trace = buildTurnTrace(
    [
      event("agent-start", { agent: "codex", invocationId: "inv-1" }),
      event("message", { role: "assistant", text: "answer exists" }),
      event("done", {}),
    ],
    { turnId: "d2", phaseId: "discuss", status: 200, ok: true }
  );
  assert.equal(trace.hasNonEmptyAssistant, true);
  assert.equal(trace.invocationAudit.lifecycleClosed, false);
  assert.deepEqual(trace.invocationAudit.orphanInvocationIds, ["inv-1"]);
});

test("aggregate invocation audit reports orphan turn context", () => {
  const turns = [
    {
      turnId: "d2",
      agentStarts: [{ agent: "codex", invocationId: "inv-1" }],
      agentExits: [],
    },
  ];
  const result = aggregateInvocationAudits(turns);
  assert.equal(result.lifecycleClosed, false);
  assert.deepEqual(result.violations, [
    {
      turnId: "d2",
      invocationId: "inv-1",
      code: "missing-agent-exit",
    },
  ]);
});

test("multi-collab hard-fails orphan invocation even when HTTP and text are green", () => {
  const turns = [
    routedTurn({
      turnId: "d1",
      phaseId: "discuss",
      from: "gemini",
      to: "codex",
    }),
    routedTurn({
      turnId: "i1",
      phaseId: "implement",
      from: "grok",
      to: "opencode",
    }),
  ];
  turns[0].agentExits = turns[0].agentExits.filter((item) => item.agent !== "codex");
  turns[0].invocationAudit = auditInvocationLifecycle(
    turns[0].agentStarts,
    turns[0].agentExits
  );
  const aggregate = aggregateTrace(turns);
  const result = evaluateMultiCollab({
    sessionId: "session-1",
    turns,
    aggregate,
    memoriesPayload: {
      memories: [{ kind: "decision", status: "captured" }],
    },
  });
  assert.equal(result.exitCode, 1);
  assert.ok(result.hardFailed.includes("M8-INVOCATION-CLOSED"));
  assert.ok(result.hardFailed.includes("M9-NO-ORPHANS"));
});

test("phase assertions reject an implementation agent appearing in discuss", () => {
  const turns = [
    closedTurn({
      turnId: "d1",
      phaseId: "discuss",
      agents: ["gemini", "codex", "grok"],
    }),
    routedTurn({
      turnId: "i1",
      phaseId: "implement",
      from: "grok",
      to: "opencode",
    }),
  ];
  const result = evaluateMultiCollab({
    sessionId: "session-1",
    turns,
    aggregate: aggregateTrace(turns),
    memoriesPayload: {
      memories: [{ kind: "decision", status: "captured" }],
    },
  });
  assert.ok(result.hardFailed.includes("M2-AGENTS-DISCUSS"));
});

test("handoff audit counts only parsed, causally linked, exited target routes", () => {
  const trace = routedTurn({
    turnId: "d1",
    phaseId: "discuss",
    from: "gemini",
    to: "codex",
  });
  assert.equal(trace.a2aHops, 1);
  assert.equal(trace.handoffAudit.handoffsClosed, true);
  assert.equal(trace.handoffAudit.handoffs[0].targetExited, true);
});

test("handoff audit rejects route without target start even when another agent started earlier", () => {
  const events = [
    event("agent-start", { agent: "gemini", invocationId: "parent" }),
    event("agent-exit", { agent: "gemini", invocationId: "parent", code: 0 }),
    event("handoff-parsed", { from: "gemini", to: "codex", ok: true }),
    event("a2a-route", {
      handoffId: "h1",
      from: "gemini",
      to: "codex",
      parentInvocationId: "parent",
      routeMessageId: "route-1",
    }),
  ];
  const result = auditHandoffs(events);
  assert.equal(result.validA2AHops, 0);
  assert.ok(result.violations.some((item) => item.code === "target-not-started"));
});

test("duplicate route from the same invocation to the same target hard-fails", () => {
  const turns = [
    routedTurn({
      turnId: "d1",
      phaseId: "discuss",
      from: "gemini",
      to: "codex",
      duplicate: true,
    }),
    routedTurn({
      turnId: "i1",
      phaseId: "implement",
      from: "grok",
      to: "opencode",
    }),
  ];
  const result = evaluateMultiCollab({
    sessionId: "session-1",
    turns,
    aggregate: aggregateTrace(turns),
    memoriesPayload: {
      memories: [{ kind: "decision", status: "captured" }],
    },
  });
  assert.ok(result.hardFailed.includes("M10-HANDOFF-CLOSED"));
  assert.ok(result.hardFailed.includes("M11-HANDOFF-DEDUP"));
});

test("multi-agent report uses the correct title and omits undefined-only fields", () => {
  const markdown = renderReportMd({
    scenarioId: "multi-auth-collab",
    exitCode: 0,
    runKind: "clean",
    cleanRunPassed: true,
    resumeRunPassed: false,
    mode: "spawn",
    sessionId: "session-1",
    turnCount: 2,
    durationMs: 100,
    hard: [],
    soft: [],
  });
  assert.match(markdown, /^# Live multi-agent collaboration · multi-auth-collab/m);
  assert.doesNotMatch(markdown, /Live solo Grok/);
  assert.doesNotMatch(markdown, /undefined/);
  assert.doesNotMatch(markdown, /\*\*capacity\*\*/);
});

test("memory retrieval audit reports availability, hit, related, and recall success rates", () => {
  const result = auditMemoryRetrieval([
    {
      turnId: "d1",
      phaseId: "discuss",
      memoryInjects: [
        {
          count: 0,
          availability: { state: "available", empty: true },
          stats: { channels: { recency: 0, related: 0 } },
        },
      ],
    },
    {
      turnId: "r1",
      phaseId: "recall",
      memoryInjects: [
        {
          count: 2,
          availability: { state: "available", empty: false },
          stats: { channels: { recency: 1, related: 1 } },
        },
      ],
    },
  ]);
  assert.equal(result.totalAttempts, 2);
  assert.equal(result.availabilityRate, 1);
  assert.equal(result.nonEmptyHitRate, 0.5);
  assert.equal(result.relatedHitRate, 0.5);
  assert.equal(result.recallSuccessRate, 1);
});

test("multi-collab hard-fails unavailable or empty recall retrieval", () => {
  const turns = [
    routedTurn({
      turnId: "d1",
      phaseId: "discuss",
      from: "gemini",
      to: "codex",
    }),
    routedTurn({
      turnId: "i1",
      phaseId: "implement",
      from: "grok",
      to: "opencode",
    }),
    closedTurn({
      turnId: "r1",
      phaseId: "recall",
      agents: ["codex"],
    }),
  ];
  turns[0].memoryInjects = [
    {
      count: 1,
      availability: { state: "unavailable", reason: "db_down" },
    },
  ];
  turns[1].memoryInjects = [
    { count: 1, availability: { state: "available" } },
  ];
  turns[2].memoryInjects = [
    { count: 0, availability: { state: "available", empty: true } },
  ];
  const result = evaluateMultiCollab({
    sessionId: "session-1",
    turns,
    aggregate: aggregateTrace(turns),
    memoriesPayload: {
      memories: [{ kind: "decision", status: "captured" }],
    },
  });
  assert.ok(result.hardFailed.includes("M12-MEMORY-AVAILABLE"));
  assert.ok(result.hardFailed.includes("M13-MEMORY-RECALL"));
});

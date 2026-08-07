const assert = require("node:assert/strict");
const test = require("node:test");

const {
  finalizeA2ARoutes,
  handoffRouteRegistry,
  collabTaskRegistry,
} = require("../../src/agents/a2a-finalize");
const { DECISIONS } = require("../../src/agents/handoff-policy");
const { summarizeHandoffOutcome } = require("../../src/agents/callbacks");

test.beforeEach(() => {
  handoffRouteRegistry.resetForTests();
  collabTaskRegistry.resetForTests();
});

test("handoff route dedupe is scoped to one thread", () => {
  const input = {
    sourceAgent: "codex",
    targetAgent: "gemini",
    sourceInvocationId: "shared-invocation",
    handoff: { to: "gemini", what: "same task" },
  };
  const first = handoffRouteRegistry.tryAcceptRoute({
    ...input,
    threadId: "thread-a",
  });
  const duplicate = handoffRouteRegistry.tryAcceptRoute({
    ...input,
    threadId: "thread-a",
  });
  const otherThread = handoffRouteRegistry.tryAcceptRoute({
    ...input,
    threadId: "thread-b",
  });

  assert.equal(first.accepted, true);
  assert.equal(duplicate.accepted, false);
  assert.equal(otherThread.accepted, true);
  assert.notEqual(first.record.handoffId, otherThread.record.handoffId);
});

function completeHandoffText(to = "opencode") {
  return [
    `@${to === "opencode" ? "OpenCode" : "Grok"} continue`,
    "```handoff",
    `to: ${to}`,
    "what: implement feature",
    "why: product need",
    "next_action: write code",
    "```",
  ].join("\n");
}

function implementationHandoffText() {
  return [
    "@Grok",
    "```handoff",
    "to: grok",
    "intent: implement",
    "what: implement the approved concrete plan",
    "why: Codex reviewed the plan",
    "next_action: edit files and run tests",
    "```",
  ].join("\n");
}

function establishBaseline(threadId) {
  const goal = collabTaskRegistry.captureUserGoal(threadId, {
    text: "Deliver the requested workflow",
  });
  collabTaskRegistry.submitSolutionBaseline(threadId, {
    actorAgentId: "codex",
    baseline: {
      user_goal_hash: goal.goalHash,
      summary: "Implement the requested workflow",
      constraints: ["Keep five phases"],
      non_goals: ["Do not move review to Codex"],
      acceptance_criteria: ["The workflow is delivered"],
    },
  });
}

test("finalize enqueues complete handoff under balanced", () => {
  const worklist = ["codex"];
  const events = [];
  const result = finalizeA2ARoutes({
    text: completeHandoffText("opencode"),
    fromAgent: "codex",
    threadId: "t1",
    sessionId: "t1",
    invocationId: "inv1",
    useWorktree: true,
    worklist,
    a2aCount: 0,
    maxDepth: 15,
    policyMode: "balanced",
    sendSse: (kind, payload) => events.push({ kind, payload }),

    agentLabels: { codex: "Codex", opencode: "OpenCode" },
  });

  assert.equal(result.enqueued.length, 1);
  assert.equal(result.enqueued[0].to, "opencode");
  assert.equal(result.enqueued[0].policy, DECISIONS.ALLOW);
  assert.match(result.enqueued[0].handoffId, /^h-/);
  assert.equal(result.enqueued[0].parentInvocationId, "inv1");
  assert.deepEqual(worklist, ["codex", "opencode"]);
  assert.ok(events.some((e) => e.kind === "handoff-parsed" || e.kind === "handoff"));
  const route = events.find((e) => e.kind === "a2a-route" && e.payload?.handoffId);
  assert.equal(route.payload.handoffId, result.enqueued[0].handoffId);
  assert.equal(route.payload.parentInvocationId, "inv1");
});

test("finalize rejects an explicit intent routed to the wrong workflow role", () => {
  const worklist = ["codex"];
  const events = [];
  const result = finalizeA2ARoutes({
    text: [
      "@OpenCode",
      "```handoff",
      "to: opencode",
      "intent: accept",
      "what: perform final acceptance",
      "why: delivery is ready",
      "next_action: accept the outcome",
      "```",
    ].join("\n"),
    fromAgent: "codex",
    threadId: "t-role-reject",
    sessionId: "t-role-reject",
    invocationId: "inv-role-reject",
    worklist,
    a2aCount: 0,
    maxDepth: 15,
    policyMode: "balanced",
    sendSse: (kind, payload) => events.push({ kind, payload }),
    agentLabels: { codex: "Codex", opencode: "OpenCode" },
  });

  assert.equal(result.enqueued.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, "target_lacks_intent_capability");
  assert.deepEqual(worklist, ["codex"]);
  const rejected = events.find((event) => event.kind === "a2a-skipped");
  assert.deepEqual(rejected.payload.allowed, ["codex"]);
});

test("finalize rejects Codex implementation handoff before Grok submits a plan", () => {
  const worklist = ["codex"];
  establishBaseline("t-plan-missing");
  const result = finalizeA2ARoutes({
    text: implementationHandoffText(),
    fromAgent: "codex",
    threadId: "t-plan-missing",
    sessionId: "t-plan-missing",
    invocationId: "inv-plan-missing",
    useWorktree: true,
    worklist,
    a2aCount: 0,
    maxDepth: 15,
    policyMode: "balanced",
    agentLabels: { codex: "Codex", grok: "Grok" },
  });

  assert.equal(result.enqueued.length, 0);
  assert.equal(result.skipped[0].reason, "implementation_plan_missing");
  assert.deepEqual(worklist, ["codex"]);
});

test("finalize binds Codex approval to Grok's submitted plan before enqueue", () => {
  const threadId = "t-plan-approved";
  establishBaseline(threadId);
  collabTaskRegistry.ensureImplementationPlanRequired(threadId, { requestedBy: "codex" });
  const submitted = collabTaskRegistry.submitImplementationPlan(threadId, {
    actorAgentId: "grok",
    plan: {
      summary: "Implement the approved change",
      files: ["src/change.js"],
      changes: ["Add the requested behavior"],
      tests: ["node --test tests/change.test.js"],
      risks: [],
    },
  });
  const worklist = ["codex"];
  const result = finalizeA2ARoutes({
    text: implementationHandoffText(),
    fromAgent: "codex",
    threadId,
    sessionId: threadId,
    invocationId: "inv-plan-approved",
    useWorktree: true,
    worklist,
    a2aCount: 0,
    maxDepth: 15,
    policyMode: "balanced",
    agentLabels: { codex: "Codex", grok: "Grok" },
  });

  assert.equal(result.enqueued.length, 1);
  assert.deepEqual(worklist, ["codex", "grok"]);
  const permission = collabTaskRegistry.implementationPermission(threadId);
  assert.equal(permission.allowed, true);
  assert.equal(permission.planHash, submitted.planHash);
});

test("finalize request_repair on worktree empty packet under balanced", () => {
  const worklist = ["codex"];
  const events = [];
  const sessions = [];
  const result = finalizeA2ARoutes({
    text: "@OpenCode\nplease implement without fence",
    fromAgent: "codex",
    threadId: "t1",
    sessionId: "t1",
    invocationId: "inv1",
    useWorktree: true,
    worklist,
    a2aCount: 0,
    maxDepth: 15,
    policyMode: "balanced",
    appendToSession: (sid, msg) => sessions.push({ sid, msg }),
    sendSse: (kind, payload) => events.push({ kind, payload }),

    agentLabels: { codex: "Codex", opencode: "OpenCode" },
  });

  assert.equal(result.enqueued.length, 0);
  assert.equal(result.repairs.length, 1);
  assert.equal(result.repairs[0].policy, DECISIONS.REQUEST_REPAIR);
  assert.deepEqual(worklist, ["codex"]);
  assert.ok(events.some((e) => e.kind === "handoff-repair-needed"));
  assert.ok(sessions.some((s) => s.msg.kind === "handoff-repair-needed"));
});

test("soft mode still enqueues worktree empty packet", () => {
  const worklist = ["codex"];
  const result = finalizeA2ARoutes({
    text: "@OpenCode\nplease implement without fence",
    fromAgent: "codex",
    threadId: "t1",
    sessionId: "t1",
    invocationId: "inv1",
    useWorktree: true,
    worklist,
    a2aCount: 0,
    maxDepth: 15,
    policyMode: "soft",
    agentLabels: { codex: "Codex", opencode: "OpenCode" },
  });
  assert.equal(result.enqueued.length, 1);
  assert.equal(result.enqueued[0].policy, DECISIONS.ALLOW_DEGRADED);
  assert.deepEqual(worklist, ["codex", "opencode"]);
});

test("finalize captures handoff via memoryCapture when block present", () => {
  const captured = [];
  finalizeA2ARoutes({
    text: completeHandoffText("opencode"),
    fromAgent: "codex",
    threadId: "t1",
    sessionId: "t1",
    invocationId: "inv1",
    worklist: ["codex"],
    a2aCount: 0,
    policyMode: "balanced",
    memoryCapture: {
      captureHandoff(input) {
        captured.push(input);
        return { captured: true, event: { id: "m1" } };
      },
    },
    sendSse: () => {},
    agentLabels: { codex: "Codex", opencode: "OpenCode" },
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].toAgent, "opencode");
  assert.equal(captured[0].quality.hasBlock, true);
});

test("max depth skips enqueue even when handoff is ok", () => {
  const worklist = ["codex"];
  const result = finalizeA2ARoutes({
    text: completeHandoffText("opencode"),
    fromAgent: "codex",
    threadId: "t1",
    sessionId: "t1",
    invocationId: "inv1",
    worklist,
    a2aCount: 2,
    maxDepth: 2,
    policyMode: "balanced",
    agentLabels: { codex: "Codex", opencode: "OpenCode" },
  });
  assert.equal(result.enqueued.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, "max_depth");
  assert.deepEqual(worklist, ["codex"]);
});

test("callback handoff summary separates accepted, repair, and skipped states", () => {
  assert.deepEqual(
    summarizeHandoffOutcome({
      mentions: ["gemini"],
      enqueued: [{ to: "gemini" }],
      repairs: [],
      skipped: [],
      mode: "balanced",
    }),
    {
      status: "accepted",
      detected: true,
      accepted: true,
      repairRequired: false,
      mentionedAgents: ["gemini"],
      queuedAgents: ["gemini"],
      repairAgents: [],
      skippedAgents: [],
      policy: "balanced",
    }
  );

  const repair = summarizeHandoffOutcome({
    mentions: ["gemini"],
    enqueued: [],
    repairs: [{ to: "gemini" }],
    skipped: [],
    mode: "balanced",
  });
  assert.equal(repair.status, "repair_required");
  assert.equal(repair.repairRequired, true);
  assert.deepEqual(repair.queuedAgents, []);

  const skipped = summarizeHandoffOutcome({
    mentions: ["gemini"],
    enqueued: [],
    repairs: [],
    skipped: [{ to: "gemini" }],
    mode: "balanced",
  });
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.accepted, false);
});

test("A2A causality stays queue-aligned when the same agent re-enters", () => {
  const worklist = ["codex"];
  const state = { a2aCauses: [] };
  let messageNo = 0;
  const appendToSession = (_sessionId, message) => ({
    messages: [{ ...message, id: `route-${++messageNo}` }],
  });

  finalizeA2ARoutes({
    text: completeHandoffText("opencode"),
    fromAgent: "codex",
    threadId: "t1",
    sessionId: "t1",
    invocationId: "inv-parent-1",
    worklist,
    a2aCount: 0,
    policyMode: "balanced",
    appendToSession,
    a2aState: state,
    agentLabels: { codex: "Codex", opencode: "OpenCode" },
  });
  finalizeA2ARoutes({
    text: completeHandoffText("opencode"),
    fromAgent: "codex",
    threadId: "t1",
    sessionId: "t1",
    invocationId: "inv-parent-2",
    worklist,
    a2aCount: 1,
    policyMode: "balanced",
    appendToSession,
    a2aState: state,
    agentLabels: { codex: "Codex", opencode: "OpenCode" },
  });

  assert.deepEqual(worklist, ["codex", "opencode", "opencode"]);
  assert.deepEqual(
    state.a2aCauses.map(({ agentId, parentInvocationId, triggerMessageId }) => ({
      agentId,
      parentInvocationId,
      triggerMessageId,
    })),
    [
      {
        agentId: "opencode",
        parentInvocationId: "inv-parent-1",
        triggerMessageId: "route-1",
      },
      {
        agentId: "opencode",
        parentInvocationId: "inv-parent-2",
        triggerMessageId: "route-2",
      },
    ]
  );
});

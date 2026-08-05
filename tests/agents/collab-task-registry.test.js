"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { STATE, createCollabTaskRegistry } = require("../../src/agents/collab-task-registry");

function route(registry, input) {
  return registry.noteAcceptedRoute({
    threadId: "thread-1",
    contentHash: `${input.fromAgent}-${input.toAgent}-${input.intent}`,
    handoff: {
      goal: "deliver the user outcome",
      what: input.what || "continue workflow",
    },
    ...input,
  });
}

function submitConcretePlan(registry) {
  return registry.submitImplementationPlan("thread-1", {
    actorAgentId: "grok",
    content: [
      "```implementation_plan",
      "summary: Implement the agreed workflow",
      "files:",
      "  - src/workflow.js",
      "changes:",
      "  - Add the requested state transition",
      "tests:",
      "  - node --test tests/workflow.test.js",
      "risks:",
      "  - Preserve legacy routes",
      "```",
    ].join("\n"),
  });
}

function approveConcretePlan(registry) {
  route(registry, { fromAgent: "codex", toAgent: "grok", intent: "plan" });
  const submitted = submitConcretePlan(registry);
  assert.equal(submitted.accepted, true);
  route(registry, { fromAgent: "codex", toAgent: "grok", intent: "implement" });
  return submitted;
}

test("five-phase registry follows discuss, implement, review, deliver, done", () => {
  const registry = createCollabTaskRegistry();

  assert.equal(
    route(registry, { fromAgent: "codex", toAgent: "gemini", intent: "discuss" }).phase,
    STATE.DISCUSS
  );
  assert.equal(
    route(registry, { fromAgent: "codex", toAgent: "grok", intent: "plan" }).phase,
    STATE.IMPLEMENT
  );
  const submitted = submitConcretePlan(registry);
  assert.equal(submitted.accepted, true);
  assert.equal(submitted.task.implementationGate.status, "pending_approval");
  assert.equal(
    route(registry, { fromAgent: "codex", toAgent: "grok", intent: "implement" })
      .implementationGate.status,
    "approved"
  );
  assert.equal(
    route(registry, { fromAgent: "grok", toAgent: "opencode", intent: "review" }).phase,
    STATE.REVIEW
  );
  const delivered = route(registry, {
    fromAgent: "opencode",
    toAgent: "codex",
    intent: "accept",
    what: "approve: diff reviewed and ready for delivery",
  });
  assert.equal(delivered.phase, STATE.DELIVER);
  assert.equal(delivered.codeReviewGate.reviewedBy, "opencode");

  const blocked = registry.markDone("thread-1", { actorAgentId: "codex" });
  assert.equal(blocked.phase, STATE.DELIVER);
  assert.equal(blocked.completionBlocked, "delivery_not_bound_to_review");

  registry.updateTask("thread-1", {
    deliveryGate: {
      commitSha: "abc123",
      ciStatus: "success",
      reviewEvidenceHash: delivered.codeReviewGate.evidenceHash,
    },
    finalGate: { verdict: "accept", acceptedCommitSha: "abc123" },
  });
  assert.equal(registry.markDone("thread-1", { actorAgentId: "codex" }).phase, STATE.DONE);
});

test("OpenCode review changes return to implement and invalidate downstream gates", () => {
  const registry = createCollabTaskRegistry();
  approveConcretePlan(registry);
  route(registry, { fromAgent: "grok", toAgent: "opencode", intent: "review" });
  const task = route(registry, {
    fromAgent: "opencode",
    toAgent: "grok",
    intent: "fix",
    what: "request-changes: P1 missing boundary test",
  });

  assert.equal(task.phase, STATE.IMPLEMENT);
  assert.equal(task.codeReviewGate, null);
  assert.equal(task.deliveryGate, null);
  assert.equal(task.finalGate, null);
});

test("Grok stays read-only until a concrete plan is approved by Codex", () => {
  const registry = createCollabTaskRegistry();
  registry.ensureImplementationPlanRequired("thread-1", { requestedBy: "codex" });

  const permission = registry.implementationPermission("thread-1");
  assert.equal(permission.allowed, false);
  assert.equal(permission.reason, "implementation_plan_missing");
  assert.equal(
    registry.submitImplementationPlan("thread-1", {
      actorAgentId: "grok",
      plan: { summary: "too vague", files: [], changes: [], tests: [] },
    }).reason,
    "invalid_or_missing_implementation_plan"
  );
  assert.equal(
    registry.shouldBlockImplementationRoute({
      threadId: "thread-1",
      fromAgent: "codex",
      toAgent: "grok",
      intent: "implement",
    }).reason,
    "implementation_plan_missing"
  );

  const submitted = submitConcretePlan(registry);
  assert.equal(submitted.accepted, true);
  assert.equal(registry.implementationPermission("thread-1").allowed, false);
  assert.equal(
    registry.approveImplementationPlan("thread-1", { actorAgentId: "gemini" }).reason,
    "plan_must_be_approved_by_lead"
  );

  const pendingRoute = registry.shouldBlockImplementationRoute({
    threadId: "thread-1",
    fromAgent: "codex",
    toAgent: "grok",
    intent: "implement",
  });
  assert.equal(pendingRoute.skip, false);
  assert.equal(pendingRoute.pendingApproval, true);

  const approved = registry.approveImplementationPlan("thread-1", {
    actorAgentId: "codex",
    planHash: submitted.planHash,
  });
  assert.equal(approved.approved, true);
  assert.equal(registry.implementationPermission("thread-1").allowed, true);
  const duplicate = submitConcretePlan(registry);
  assert.equal(duplicate.reused, true);
  assert.equal(registry.implementationPermission("thread-1").allowed, true);
});

test("a revised Grok plan invalidates the prior plan approval", () => {
  const registry = createCollabTaskRegistry();
  const first = approveConcretePlan(registry);
  assert.equal(registry.implementationPermission("thread-1").allowed, true);

  const revised = registry.submitImplementationPlan("thread-1", {
    actorAgentId: "grok",
    plan: {
      summary: "Revised implementation",
      files: ["src/workflow.js", "tests/workflow.test.js"],
      changes: ["Change the transition", "Add a regression test"],
      tests: ["node --test tests/workflow.test.js"],
      risks: [],
    },
  });
  assert.equal(revised.accepted, true);
  assert.notEqual(revised.planHash, first.planHash);
  assert.equal(registry.implementationPermission("thread-1").allowed, false);
  assert.equal(registry.getTask("thread-1").codeReviewGate, null);
});

test("an approval gate without the matching persisted plan artifact stays locked", () => {
  const registry = createCollabTaskRegistry();
  registry.updateTask("thread-1", {
    artifacts: {},
    implementationGate: {
      status: "approved",
      planHash: "forged-plan",
      approvedPlanHash: "forged-plan",
      approvedBy: "codex",
    },
  });
  const permission = registry.implementationPermission("thread-1");
  assert.equal(permission.allowed, false);
  assert.equal(permission.reason, "implementation_plan_artifact_missing");
});

test("explicit discussion intent remains discuss even when the session uses a worktree", () => {
  const registry = createCollabTaskRegistry();
  const task = route(registry, {
    fromAgent: "codex",
    toAgent: "gemini",
    intent: "discuss",
    useWorktree: true,
  });
  assert.equal(task.phase, STATE.DISCUSS);
});

test("persistent registry delegates state and event writes to its repository", () => {
  const stored = new Map();
  const repository = {
    get: (id) => stored.get(id) || null,
    save(task, event) {
      const history = [...(task.history || []), ...(event ? [event] : [])];
      const saved = { ...task, version: Number(task.version || 0) + 1, history };
      stored.set(task.threadId, saved);
      return saved;
    },
  };
  const first = createCollabTaskRegistry({ repository });
  route(first, { fromAgent: "codex", toAgent: "grok", intent: "plan" });

  const afterRestart = createCollabTaskRegistry({ repository });
  assert.equal(afterRestart.getTask("thread-1").phase, STATE.IMPLEMENT);
  assert.equal(afterRestart.getTask("thread-1").history.length, 1);
});

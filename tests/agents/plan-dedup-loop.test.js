"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  parseImplementationPlan,
  hashImplementationPlan,
  hashIsomorphicPlan,
  parseCodeReview,
} = require("../../src/agents/workflow-gates");
const { createCollabTaskRegistry } = require("../../src/agents/collab-task-registry");
const { processWorkflowEvidenceOutput } = require("../../src/agents/workflow-evidence");

const PLAN_A = [
  "```implementation_plan",
  "summary: Fix Dayjs utcOffset mutation bug",
  "files:",
  "  - src/index.js",
  "  - test/offset.test.js",
  "changes:",
  "  - Clone instance before applying offset",
  "tests:",
  "  - npm test",
  "risks:",
  "  - Low risk",
  "```",
].join("\n");

const PLAN_A_REORDERED = [
  "```implementation_plan",
  "summary:  fix dayjs utcoffset mutation bug.  ",
  "files:",
  "  - test/offset.test.js",
  "  - src/index.js",
  "changes:",
  "  - Clone instance before applying offset",
  "tests:",
  "  - npm test",
  "risks:",
  "  - Low risk",
  "```",
].join("\n");

const PLAN_B = [
  "```implementation_plan",
  "summary: Completely different refactor plan",
  "files:",
  "  - src/server.js",
  "changes:",
  "  - Rewrite HTTP router",
  "tests:",
  "  - npm run test:router",
  "```",
].join("\n");

test("hashIsomorphicPlan matches structurally equivalent plans with reordered files or normalized whitespace", () => {
  const planA = parseImplementationPlan(PLAN_A);
  const planAReordered = parseImplementationPlan(PLAN_A_REORDERED);
  const planB = parseImplementationPlan(PLAN_B);

  // Exact hash differs due to file ordering and summary formatting
  assert.notEqual(hashImplementationPlan(planA), hashImplementationPlan(planAReordered));

  // Isomorphic hash matches
  assert.equal(hashIsomorphicPlan(planA), hashIsomorphicPlan(planAReordered));
  assert.equal(hashIsomorphicPlan(planA), hashIsomorphicPlan(planAReordered));

  // Different plan does not match
  assert.notEqual(hashIsomorphicPlan(planA), hashIsomorphicPlan(planB));
  assert.notEqual(hashIsomorphicPlan(planA), hashIsomorphicPlan(planB));
});

test("collabTaskRegistry tracks plan repeats and terminates loop after exceeding threshold", () => {
  const registry = createCollabTaskRegistry();
  const threadId = "test-plan-loop-1";
  const plan = parseImplementationPlan(PLAN_A);

  // 1st submission
  const first = registry.submitImplementationPlan(threadId, {
    invocationId: "fixture-1",
    progressKey: "head-unchanged",
    actorAgentId: "codex",
    actorDuty: "plan",
    plan,
    maxPlanRepeats: 3,
  });
  assert.equal(first.accepted, true);
  assert.equal(first.reused, undefined);
  assert.equal(first.consecutiveRepeats, 1);
  assert.equal(first.loopDetected, undefined);

  // 2nd submission (exact same plan)
  const second = registry.submitImplementationPlan(threadId, {
    invocationId: "fixture-2",
    progressKey: "head-unchanged",
    actorAgentId: "codex",
    actorDuty: "plan",
    plan,
    maxPlanRepeats: 3,
  });
  assert.equal(second.accepted, true);
  assert.equal(second.reused, true);
  assert.equal(second.consecutiveRepeats, 2);

  // 3rd submission (isomorphic reordered plan)
  const planReordered = parseImplementationPlan(PLAN_A_REORDERED);
  const third = registry.submitImplementationPlan(threadId, {
    invocationId: "fixture-3",
    progressKey: "head-unchanged",
    actorAgentId: "codex",
    actorDuty: "plan",
    plan: planReordered,
    maxPlanRepeats: 3,
  });
  assert.equal(third.accepted, true);
  assert.equal(third.consecutiveRepeats, 3);

  // 4th submission -> exceeds maxPlanRepeats (3) -> terminates with duplicate_plan_loop_detected
  const fourth = registry.submitImplementationPlan(threadId, {
    invocationId: "fixture-4",
    progressKey: "head-unchanged",
    actorAgentId: "codex",
    actorDuty: "plan",
    plan,
    maxPlanRepeats: 3,
  });
  assert.equal(fourth.accepted, false);
  assert.equal(fourth.loopDetected, true);
  assert.equal(fourth.reason, "duplicate_plan_loop_detected");
  assert.equal(fourth.consecutiveRepeats, 4);

  // Permission and routing should be blocked
  const permission = registry.implementationPermission(threadId);
  assert.equal(permission.allowed, false);
  assert.equal(permission.reason, "duplicate_plan_loop_detected");

  const routeBlock = registry.shouldBlockImplementationRoute({
    threadId,
    intent: "implement",
    toDuty: "implement",
  });
  assert.equal(routeBlock.skip, true);
  assert.equal(routeBlock.reason, "duplicate_plan_loop_detected");
});

test("submitting a non-isomorphic plan resets repeat counter and clears loop detection", () => {
  const registry = createCollabTaskRegistry();
  const threadId = "test-plan-reset-1";
  const planA = parseImplementationPlan(PLAN_A);
  const planB = parseImplementationPlan(PLAN_B);

  // 2 consecutive submissions of plan A
  registry.submitImplementationPlan(threadId, {
    invocationId: "fixture-5",
    progressKey: "head-unchanged",
    actorAgentId: "codex",
    actorDuty: "plan",
    plan: planA,
    maxPlanRepeats: 2,
  });
  const rep2 = registry.submitImplementationPlan(threadId, {
    invocationId: "fixture-6",
    progressKey: "head-unchanged",
    actorAgentId: "codex",
    actorDuty: "plan",
    plan: planA,
    maxPlanRepeats: 2,
  });
  assert.equal(rep2.consecutiveRepeats, 2);

  // Now submit different plan B -> resets counter
  const newPlan = registry.submitImplementationPlan(threadId, {
    invocationId: "fixture-7",
    progressKey: "head-unchanged",
    actorAgentId: "codex",
    actorDuty: "plan",
    plan: planB,
    maxPlanRepeats: 2,
  });
  assert.equal(newPlan.accepted, true);
  assert.equal(newPlan.consecutiveRepeats, 1);
  assert.equal(newPlan.task.implementationGate.loopDetected, false);
});

test("processWorkflowEvidenceOutput emits loop-detected and plan-warning events", () => {
  const registry = createCollabTaskRegistry();
  const threadId = "test-evidence-loop-1";
  const plan = parseImplementationPlan(PLAN_A);

  // Pre-seed up to threshold
  registry.submitImplementationPlan(threadId, {
    invocationId: "fixture-8",
    progressKey: "head-unchanged",
    actorAgentId: "codex",
    actorDuty: "plan",
    plan,
    maxPlanRepeats: 2,
  });
  registry.submitImplementationPlan(threadId, {
    invocationId: "fixture-9",
    progressKey: "head-unchanged",
    actorAgentId: "codex",
    actorDuty: "plan",
    plan,
    maxPlanRepeats: 2,
  });

  // 3rd generation exceeds maxPlanRepeats (2)
  const events = processWorkflowEvidenceOutput({
    invocationId: "third-generation",
    progressKey: "head-unchanged",
    agent: "codex",
    duty: "plan",
    content: PLAN_A,
    threadId,
    registry,
    maxPlanRepeats: 2,
  });

  assert.equal(events.length, 2);
  assert.equal(events[0].event, "implementation-plan-loop-detected");
  assert.equal(events[0].payload.loopDetected, true);
  assert.equal(events[0].payload.consecutiveRepeats, 3);

  assert.equal(events[1].event, "plan-warning");
  assert.equal(events[1].payload.warning, "duplicate_plan_loop_detected");
  assert.equal(events[1].payload.consecutiveRepeats, 3);
});

test("collabTaskRegistry detects duplicate code review loops", () => {
  const registry = createCollabTaskRegistry();
  const threadId = "test-review-loop-1";
  const review = parseCodeReview(
    [
      "```code_review",
      "verdict: changes_requested",
      "summary: Replay pagination missing",
      "findings:",
      "  - P1: Memory unbounded on replay",
      "tests:",
      "  - node --test tests/replay.test.js",
      "```",
    ].join("\n")
  );

  registry.captureUserGoal(threadId, { text: "Fix bug" });

  for (let i = 0; i < 3; i++) {
    const res = registry.recordCodeReview(threadId, {
      invocationId: "fixture-10" + i,
      progressKey: "head-unchanged",
      actorAgentId: "codex",
      actorDuty: "review",
      review,
      maxReviewRepeats: 3,
    });
    assert.equal(res.accepted, true);
    assert.equal(res.consecutiveRepeats, i + 1);
  }

  // 4th review
  const fourth = registry.recordCodeReview(threadId, {
    invocationId: "fixture-11",
    progressKey: "head-unchanged",
    actorAgentId: "codex",
    actorDuty: "review",
    review,
    maxReviewRepeats: 3,
  });
  assert.equal(fourth.accepted, false);
  assert.equal(fourth.loopDetected, true);
  assert.equal(fourth.reason, "duplicate_review_loop_detected");
  assert.equal(fourth.consecutiveRepeats, 4);
});

test("callback and final evidence are idempotent within one invocation", () => {
  const registry = createCollabTaskRegistry();
  const plan = parseImplementationPlan(PLAN_A);
  for (let i = 0; i < 5; i++) {
    const result = registry.submitImplementationPlan("same-round", {
      actorAgentId: "grok",
      actorDuty: "implement",
      invocationId: "i1",
      plan,
    });
    assert.equal(result.accepted, true);
    assert.notEqual(result.loopDetected, true);
  }
  const detailed = {
    verdict: "changes_requested",
    summary: "Detailed review",
    findings: ["Fix timeout"],
    tests: ["npm test failed"],
  };
  const a = registry.recordCodeReview("same-round", {
    actorAgentId: "codex",
    actorDuty: "review",
    invocationId: "i2",
    review: detailed,
  });
  const b = registry.recordCodeReview("same-round", {
    actorAgentId: "codex",
    actorDuty: "review",
    invocationId: "i2",
    review: { ...detailed, summary: "Brief summary" },
  });
  assert.equal(b.reused, true);
  assert.equal(b.reviewEvidenceHash, a.reviewEvidenceHash);
  assert.equal(b.task.artifacts.codeReview.summary, detailed.summary);
});

test("new Git progress resets duplicate-plan detection", () => {
  const registry = createCollabTaskRegistry();
  const plan = parseImplementationPlan(PLAN_A);
  for (let i = 0; i < 6; i++) {
    const result = registry.submitImplementationPlan("progress", {
      actorAgentId: "grok",
      actorDuty: "implement",
      invocationId: "i" + i,
      progressKey: "commit" + i,
      plan,
    });
    assert.equal(result.accepted, true);
    assert.notEqual(result.loopDetected, true);
  }
});

test("repeated delivery in later invocation also counts only once", () => {
  const registry = createCollabTaskRegistry();
  const plan = parseImplementationPlan(PLAN_A);
  registry.submitImplementationPlan("later", {
    actorAgentId: "grok",
    actorDuty: "implement",
    invocationId: "i1",
    plan,
  });
  for (let i = 0; i < 5; i++) {
    const result = registry.submitImplementationPlan("later", {
      actorAgentId: "grok",
      actorDuty: "implement",
      invocationId: "i2",
      plan,
    });
    assert.equal(result.accepted, true);
  }
  assert.equal(registry.getTask("later").implementationGate.consecutiveRepeats, 2);
});

test("unbound evidence is rejected before creating collaboration state", () => {
  const registry = createCollabTaskRegistry();
  for (const invocationId of [undefined, "", "   ", 123, {}]) {
    assert.equal(
      registry.submitImplementationPlan("unbound", {
        invocationId,
        actorDuty: "plan",
        plan: parseImplementationPlan(PLAN_A),
      }).reason,
      "missing_invocation"
    );
    assert.equal(
      registry.recordCodeReview("unbound", { invocationId, actorDuty: "review" }).reason,
      "missing_invocation"
    );
  }
  assert.equal(registry.getTask("unbound"), null);
});

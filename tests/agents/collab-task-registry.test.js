"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { STATE, createCollabTaskRegistry } = require("../../src/agents/collab-task-registry");

function establishSolutionBaseline(registry) {
  const goal = registry.captureUserGoal("thread-1", {
    text: "Deliver the user outcome",
    messageId: "message-1",
  });
  const solution = registry.submitSolutionBaseline("thread-1", {
    actorAgentId: "codex",
    actorDuty: "discuss",
    baseline: {
      user_goal_hash: goal.goalHash,
      summary: "Implement and verify the agreed workflow",
      constraints: ["Keep the five phases"],
      non_goals: ["Do not move review to Codex"],
      acceptance_criteria: ["The workflow is delivered"],
    },
  });
  assert.equal(solution.accepted, true);
  return { goalHash: goal.goalHash, solutionHash: solution.solutionHash };
}

function route(registry, input) {
  const sourceDutyByIntent = {
    discuss: "discuss",
    plan: "discuss",
    implement: "discuss",
    review: "implement",
    fix: "review",
    accept: "review",
  };
  return registry.noteAcceptedRoute({
    threadId: "thread-1",
    contentHash: `${input.fromAgent}-${input.toAgent}-${input.intent}`,
    handoff: {
      goal: "deliver the user outcome",
      what: input.what || "continue workflow",
    },
    fromDuty: input.fromDuty || sourceDutyByIntent[input.intent] || "discuss",
    toDuty: input.toDuty || input.intent || "discuss",
    ...input,
  });
}

function submitConcretePlan(registry) {
  return registry.submitImplementationPlan("thread-1", {
    actorAgentId: "grok",
    actorDuty: "plan",
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
  establishSolutionBaseline(registry);
  route(registry, { fromAgent: "codex", toAgent: "grok", intent: "plan" });
  const submitted = submitConcretePlan(registry);
  assert.equal(submitted.accepted, true);
  route(registry, { fromAgent: "codex", toAgent: "grok", intent: "implement" });
  return submitted;
}

test("five-phase registry follows discuss, implement, review, deliver, done", () => {
  const registry = createCollabTaskRegistry({
    readWorkspace: () => ({ headSha: "a".repeat(40), porcelain: [] }),
  });

  assert.equal(
    route(registry, { fromAgent: "codex", toAgent: "gemini", intent: "discuss" }).phase,
    STATE.DISCUSS
  );
  const baseline = establishSolutionBaseline(registry);
  assert.equal(
    route(registry, { fromAgent: "codex", toAgent: "grok", intent: "plan" }).phase,
    STATE.IMPLEMENT
  );
  const submitted = submitConcretePlan(registry);
  assert.equal(submitted.accepted, true);
  assert.equal(submitted.task.implementationGate.status, "pending_approval");
  assert.equal(
    route(registry, { fromAgent: "codex", toAgent: "grok", intent: "implement" }).implementationGate
      .status,
    "approved"
  );
  assert.equal(
    route(registry, { fromAgent: "grok", toAgent: "opencode", intent: "review" }).phase,
    STATE.REVIEW
  );
  const reviewed = registry.recordCodeReview("thread-1", {
    actorAgentId: "opencode",
    actorDuty: "review",
    review: {
      verdict: "approve",
      summary: "No blocking findings",
      findings: ["none"],
      tests: ["npm run verify:pr: passed"],
    },
  });
  assert.equal(reviewed.accepted, true);
  const delivered = route(registry, {
    fromAgent: "opencode",
    toAgent: "codex",
    intent: "accept",
  });
  assert.equal(delivered.phase, STATE.DELIVER);
  assert.equal(delivered.codeReviewGate.reviewedBy, "opencode");
  assert.equal(reviewed.task.history.at(-1).actorKind, "seat");
  assert.equal(reviewed.task.history.at(-1).type, "code_review_approved");

  const blocked = registry.submitFinalAcceptance("thread-1", {
    actorAgentId: "codex",
    actorDuty: "accept",
    acceptance: {
      verdict: "accept",
      user_goal_hash: baseline.goalHash,
      solution_hash: baseline.solutionHash,
      implementation_plan_hash: delivered.artifacts.implementationPlan.hash,
      commit_sha: "a".repeat(40),
      checks: ["The workflow is delivered => pass: evidence"],
      gaps: ["none"],
    },
  });
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.reason, "final_commit_mismatch");
  assert.equal(registry.getTask("thread-1").phase, STATE.DELIVER);

  const commitSha = "a".repeat(40);
  const reviewEvidenceHash = delivered.codeReviewGate.evidenceHash;
  registry.updateTask("thread-1", {
    artifacts: {
      ...delivered.artifacts,
      codeReview: { hash: reviewEvidenceHash, commitSha },
      delivery: {
        reviewEvidenceHash,
        commitSha,
        prUrl: "https://github.com/acme/repo/pull/1",
        ciStatus: "success",
      },
    },
    deliveryGate: {
      commitSha,
      prUrl: "https://github.com/acme/repo/pull/1",
      ciStatus: "success",
      reviewEvidenceHash,
    },
  });
  const completed = registry.submitFinalAcceptance("thread-1", {
    actorAgentId: "codex",
    actorDuty: "accept",
    acceptance: {
      verdict: "accept",
      user_goal_hash: baseline.goalHash,
      solution_hash: baseline.solutionHash,
      implementation_plan_hash: delivered.artifacts.implementationPlan.hash,
      commit_sha: commitSha,
      checks: ["The workflow is delivered => pass: evidence"],
      gaps: ["none"],
    },
  });
  assert.equal(completed.verdict, "accepted");
  assert.equal(completed.task.phase, STATE.DONE);
  assert.equal(completed.task.taskStatus, "accepted");
  assert.equal(completed.task.artifacts.acceptanceDecision.actorKind, "seat");
});

test("review Duty changes return to implement and keep the requested review gate", () => {
  const registry = createCollabTaskRegistry();
  approveConcretePlan(registry);
  route(registry, { fromAgent: "grok", toAgent: "opencode", intent: "review" });
  const reviewed = registry.recordCodeReview("thread-1", {
    actorAgentId: "opencode",
    actorDuty: "review",
    review: {
      verdict: "changes_requested",
      summary: "P1 missing boundary test",
      findings: ["P1 src/workflow.js missing a regression"],
      tests: ["targeted tests passed"],
    },
  });
  assert.equal(reviewed.accepted, true);
  const task = route(registry, {
    fromAgent: "opencode",
    toAgent: "grok",
    intent: "fix",
    what: "request-changes: P1 missing boundary test",
  });

  assert.equal(task.phase, STATE.IMPLEMENT);
  assert.equal(task.codeReviewGate.verdict, "changes_requested");
  assert.equal(task.codeReviewGate.reviewedBy, "opencode");
  assert.equal(task.deliveryGate, null);
  assert.equal(task.finalGate, null);
});

test("handoff goal does not overwrite the captured user goal", () => {
  const registry = createCollabTaskRegistry();
  const captured = registry.captureUserGoal("thread-1", {
    text: "项目上只补两件，不要再堆功能",
  });
  const task = route(registry, {
    fromAgent: "codex",
    toAgent: "grok",
    intent: "plan",
    handoff: { goal: "按首轮 review 的 P1/P2 修复参与上下文", what: "submit the plan" },
  });
  assert.equal(task.goal, "项目上只补两件，不要再堆功能");
  assert.equal(task.artifacts.userGoal.text, "项目上只补两件，不要再堆功能");
  assert.equal(task.artifacts.userGoal.hash, captured.goalHash);
});

test("informal approve language on a handoff does not write the review gate", () => {
  const registry = createCollabTaskRegistry();
  approveConcretePlan(registry);
  route(registry, { fromAgent: "grok", toAgent: "opencode", intent: "review" });
  const task = route(registry, {
    fromAgent: "opencode",
    toAgent: "codex",
    intent: "accept",
    what: "approve: diff reviewed and ready for delivery",
  });
  assert.equal(task.phase, STATE.DELIVER);
  assert.equal(task.codeReviewGate, null);
});

test("implementation Duty stays read-only until a concrete plan is approved", () => {
  const registry = createCollabTaskRegistry();
  registry.ensureImplementationPlanRequired("thread-1", { requestedBy: "codex" });

  const permission = registry.implementationPermission("thread-1");
  assert.equal(permission.allowed, false);
  assert.equal(permission.reason, "implementation_plan_missing");
  assert.equal(
    registry.submitImplementationPlan("thread-1", {
      actorAgentId: "grok",
      actorDuty: "plan",
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
      fromDuty: "discuss",
      toDuty: "implement",
    }).reason,
    "implementation_plan_missing"
  );

  const submitted = submitConcretePlan(registry);
  assert.equal(submitted.accepted, true);
  assert.equal(registry.implementationPermission("thread-1").allowed, false);
  assert.equal(
    registry.approveImplementationPlan("thread-1", {
      actorAgentId: "gemini",
      actorDuty: "review",
    }).reason,
    "plan_approval_requires_discuss_or_accept_duty"
  );

  const pendingRoute = registry.shouldBlockImplementationRoute({
    threadId: "thread-1",
    fromAgent: "codex",
    toAgent: "grok",
    intent: "implement",
    fromDuty: "discuss",
    toDuty: "implement",
  });
  assert.equal(pendingRoute.skip, false);
  assert.equal(pendingRoute.pendingApproval, true);

  const approved = registry.approveImplementationPlan("thread-1", {
    actorAgentId: "codex",
    actorDuty: "discuss",
    planHash: submitted.planHash,
  });
  assert.equal(approved.approved, true);
  assert.equal(registry.implementationPermission("thread-1").allowed, true);
  const duplicate = submitConcretePlan(registry);
  assert.equal(duplicate.reused, true);
  assert.equal(registry.implementationPermission("thread-1").allowed, true);
});

test("a revised implementation plan invalidates the prior approval", () => {
  const registry = createCollabTaskRegistry();
  const first = approveConcretePlan(registry);
  assert.equal(registry.implementationPermission("thread-1").allowed, true);

  const revised = registry.submitImplementationPlan("thread-1", {
    actorAgentId: "grok",
    actorDuty: "plan",
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

test("plan Duty cannot route until the solution baseline matches the original user goal", () => {
  const registry = createCollabTaskRegistry();
  assert.equal(
    registry.shouldBlockEvidenceRoute({
      threadId: "thread-1",
      fromAgent: "codex",
      toAgent: "grok",
      intent: "plan",
    }).reason,
    "user_goal_missing"
  );
  registry.captureUserGoal("thread-1", { text: "Original user goal" });
  assert.equal(
    registry.shouldBlockEvidenceRoute({
      threadId: "thread-1",
      fromAgent: "codex",
      toAgent: "grok",
      intent: "plan",
    }).reason,
    "solution_baseline_missing"
  );
  establishSolutionBaseline(registry);
  assert.equal(
    registry.shouldBlockEvidenceRoute({
      threadId: "thread-1",
      fromAgent: "codex",
      toAgent: "grok",
      intent: "plan",
    }).skip,
    false
  );
});

test("delivery and accept-duty completion bind outcome hashes to the current worktree", async () => {
  let workspace = { headSha: "a".repeat(40), porcelain: [] };
  const registry = createCollabTaskRegistry({
    readWorkspace: () => {
      if (workspace instanceof Error) throw workspace;
      return workspace;
    },
  });
  const baseline = establishSolutionBaseline(registry);
  route(registry, { fromAgent: "codex", toAgent: "grok", intent: "plan" });
  const implementation = submitConcretePlan(registry);
  route(registry, { fromAgent: "codex", toAgent: "grok", intent: "implement" });
  route(registry, { fromAgent: "grok", toAgent: "opencode", intent: "review" });
  const commitSha = "a".repeat(40);
  const prUrl = "https://github.com/acme/repo/pull/7";
  const delivery = registry.recordDeliveryEvidence("thread-1", {
    actorAgentId: "opencode",
    actorDuty: "deliver",
    review: {
      verdict: "approve",
      summary: "No blocking findings",
      findings: ["none"],
      tests: ["npm run verify:pr: passed"],
    },
    receipt: {
      commit_sha: commitSha,
      pr_url: prUrl,
      base_branch: "master",
      verification: ["npm run verify:pr: passed", "GitHub checks: passed"],
    },
    verification: {
      verified: true,
      commitSha,
      commitSubject: "feat(collab): verify delivery evidence",
      commitBody: "Bind the reviewed commit to the verified pull request and CI evidence.",
      branch: "codex/session-1",
      baseBranch: "master",
      prUrl,
      prNumber: 7,
      prTitle: "Verify OpenCode delivery evidence",
      prBody: [
        "## 意图",
        "交付经过审查的实现",
        "## 主链路影响",
        "不改变 invocation 主链路",
        "## 路径变化（公开入口 / 双写）",
        "没有新增公开入口或双写",
        "## 测试（旧接口测试是否处理）",
        "相关验证通过，未保留旧接口测试",
        "## 风险与回滚",
        "风险可通过回滚该提交消除",
      ].join("\n\n"),
      ciStatus: "success",
    },
  });
  assert.equal(delivery.accepted, true);
  assert.equal(delivery.readyForAcceptance, true);
  assert.equal(
    registry.shouldBlockEvidenceRoute({
      threadId: "thread-1",
      fromAgent: "opencode",
      toAgent: "codex",
      intent: "accept",
    }).skip,
    false
  );

  const payload = {
    actorAgentId: "codex",
    actorDuty: "accept",
    acceptance: {
      verdict: "accept",
      user_goal_hash: baseline.goalHash,
      solution_hash: baseline.solutionHash,
      implementation_plan_hash: implementation.planHash,
      commit_sha: commitSha,
      checks: ["The workflow is delivered => pass: PR #7 and green CI"],
      gaps: ["none"],
    },
  };
  const { createSessionRoutes } = require("../../src/server/session-routes");
  async function collaborationRequest() {
    const res = {};
    const handler = createSessionRoutes({
      collabTaskRegistry: registry,
      getSession: () => ({ id: "thread-1" }),
      sendJson: (_res, status, body) => Object.assign(res, { status, body }),
    });
    await handler(
      { method: "GET" },
      res,
      new URL("http://localhost/api/sessions/thread-1/collaboration")
    );
    return res;
  }
  for (const [snapshot, reason] of [
    [{ headSha: "b".repeat(40), porcelain: [] }, "acceptance_head_mismatch"],
    [{ headSha: commitSha, porcelain: [" M src/workflow.js"] }, "acceptance_worktree_dirty"],
    [null, "acceptance_workspace_unavailable"],
    [{ headSha: commitSha }, "acceptance_workspace_unavailable"],
    [new Error("Git unavailable"), "acceptance_workspace_unavailable"],
  ]) {
    workspace = snapshot;
    const acceptance = registry.submitFinalAcceptance("thread-1", payload);
    assert.equal(acceptance.accepted, true);
    assert.equal(acceptance.verdict, "incomplete");
    assert.equal(acceptance.reason, reason);
    assert.notEqual(registry.getTask("thread-1").phase, STATE.DONE);
    assert.equal(registry.getTask("thread-1").taskStatus, "active");
    assert.equal(registry.getTask("thread-1").history.at(-1).reason, reason);
  }
  workspace = { headSha: commitSha, porcelain: [] };
  const completed = registry.submitFinalAcceptance("thread-1", payload);
  assert.equal(completed.verdict, "accepted");
  assert.equal(completed.task.phase, STATE.DONE);
  assert.equal(completed.task.taskStatus, "accepted");
  const decisionEvent = completed.task.history.at(-1);
  assert.equal(decisionEvent.type, "final_acceptance_decided");
  assert.equal(decisionEvent.actorKind, "seat");
  assert.equal(decisionEvent.actorId, "codex");

  workspace = { headSha: "b".repeat(40), porcelain: [] };
  const stale = await collaborationRequest();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.collaboration.acceptance.verdict, "incomplete");
  assert.equal(stale.body.collaboration.acceptance.reason, "acceptance_head_mismatch");
  assert.equal(registry.getTask("thread-1").artifacts.acceptanceDecision.verdict, "accepted");
  workspace = { headSha: commitSha, porcelain: [] };

  registry.captureUserGoal("thread-1", { text: "Rewritten goal", force: true });
  assert.equal(registry.getTask("thread-1").artifacts.acceptanceDecision, undefined);
  assert.equal(registry.getTask("thread-1").taskStatus, "active");
});

test("forged delivery and final gate JSON cannot replace their persisted artifacts", () => {
  const registry = createCollabTaskRegistry();
  const baseline = establishSolutionBaseline(registry);
  route(registry, { fromAgent: "codex", toAgent: "grok", intent: "plan" });
  const implementation = submitConcretePlan(registry);
  route(registry, { fromAgent: "codex", toAgent: "grok", intent: "implement" });
  const commitSha = "a".repeat(40);
  registry.updateTask("thread-1", {
    codeReviewGate: { verdict: "approve", evidenceHash: "forged-review" },
    deliveryGate: {
      reviewEvidenceHash: "forged-review",
      commitSha,
      prUrl: "https://github.com/acme/repo/pull/7",
      ciStatus: "success",
    },
    finalGate: {
      verdict: "accept",
      evidenceHash: "forged-final",
      userGoalHash: baseline.goalHash,
      solutionHash: baseline.solutionHash,
      implementationPlanHash: implementation.planHash,
      acceptedCommitSha: commitSha,
    },
  });
  assert.equal(
    registry.shouldBlockEvidenceRoute({
      threadId: "thread-1",
      fromAgent: "opencode",
      toAgent: "codex",
      intent: "accept",
    }).reason,
    "code_review_artifact_missing"
  );
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
  establishSolutionBaseline(first);
  route(first, { fromAgent: "codex", toAgent: "grok", intent: "plan" });

  const afterRestart = createCollabTaskRegistry({ repository });
  assert.equal(afterRestart.getTask("thread-1").phase, STATE.IMPLEMENT);
  assert.equal(afterRestart.getTask("thread-1").history.length, 3);
});

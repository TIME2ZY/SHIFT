"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createCollabTaskRegistry } = require("../../src/agents/collab-task-registry");
const { processWorkflowEvidenceOutput } = require("../../src/agents/workflow-evidence");

test("a missing implementation plan emits a required event without writing evidence", () => {
  const registry = createCollabTaskRegistry();
  const events = processWorkflowEvidenceOutput({
    agent: "codex",
    duty: "plan",
    threadId: "thread-1",
    registry,
    content: "```implementation_plan\nsummary: Missing files and tests\n```",
  });
  assert.equal(events[0].event, "implementation-plan-required");
  assert.equal(events[0].payload.reason, "invalid_or_missing_implementation_plan");
  assert.equal(registry.getTask("thread-1"), null);
});

for (const agent of ["codex", "gemini", "grok", "opencode"]) {
  test(`${agent} submits and revises plan evidence independently of permission callbacks`, () => {
    const registry = createCollabTaskRegistry();
    const content = [
      "```implementation_plan",
      "summary: Implement the requested behavior",
      "files:",
      "  - src/example.js",
      "changes:",
      "  - Preserve the public contract",
      "tests:",
      "  - Run the regression test",
      "```",
    ].join("\n");
    const input = { agent, duty: "plan", content, threadId: "thread-1", registry };
    const submitted = processWorkflowEvidenceOutput(input)[0];
    assert.equal(submitted.event, "implementation-plan-submitted");
    const approval = registry.approveImplementationPlan("thread-1", {
      actorAgentId: agent,
      actorDuty: "discuss",
    });
    assert.equal(approval.approved, true);
    const repeated = processWorkflowEvidenceOutput(input)[0];
    assert.equal(repeated.payload.reused, true);
    assert.equal(registry.implementationPermission("thread-1").allowed, true);

    const revised = processWorkflowEvidenceOutput({
      ...input,
      duty: "fix",
      content: content.replace("Preserve the public contract", "Correct the missing boundary"),
    })[0];
    assert.equal(revised.event, "implementation-plan-submitted");
    assert.notEqual(revised.payload.planHash, submitted.payload.planHash);
    assert.equal(registry.implementationPermission("thread-1").allowed, false);
  });
}

test("discuss Duty output becomes the baseline regardless of Seat provider", () => {
  const registry = createCollabTaskRegistry();
  const goal = registry.captureUserGoal("thread-1", { text: "Deliver the requested outcome" });
  const events = processWorkflowEvidenceOutput({
    agent: "codex",
    duty: "discuss",
    threadId: "thread-1",
    registry,
    content: [
      "```solution_baseline",
      `user_goal_hash: ${goal.goalHash}`,
      "summary: Add evidence-bound delivery gates",
      "constraints:",
      "  - Keep five phases",
      "non_goals:",
      "  - Do not move review to Codex",
      "acceptance_criteria:",
      "  - Delivery is independently verified",
      "```",
    ].join("\n"),
  });
  assert.equal(events[0].event, "solution-baseline-submitted");
  assert.match(registry.getTask("thread-1").artifacts.solutionBaseline.hash, /^[a-f0-9]{16}$/);
});

test("review Duty output is independently verified regardless of Seat provider", () => {
  const calls = [];
  const registry = {
    recordCodeReview(threadId, input) {
      calls.push({ kind: "review", threadId, input });
      return {
        accepted: true,
        verdict: input.review.verdict,
        reviewEvidenceHash: "review-1",
      };
    },
    recordDeliveryEvidence(threadId, input) {
      calls.push({ kind: "delivery", threadId, input });
      return { accepted: true, readyForAcceptance: true, reviewEvidenceHash: "review-1" };
    },
  };
  const content = [
    "```code_review",
    "verdict: approve",
    "summary: No blockers",
    "findings:",
    "  - none",
    "tests:",
    "  - npm run verify:pr: passed",
    "```",
    "```delivery_receipt",
    `commit_sha: ${"a".repeat(40)}`,
    "pr_url: https://github.com/acme/repo/pull/7",
    "base_branch: master",
    "verification:",
    "  - GitHub checks: passed",
    "```",
  ].join("\n");
  const events = processWorkflowEvidenceOutput({
    agent: "gemini",
    duty: "review",
    content,
    threadId: "thread-1",
    registry,
    cwd: "C:/repo.worktrees/thread-1",
    branch: "codex/session-thread-1",
    deliveryVerifier: {
      verify(input) {
        assert.equal(input.branch, "codex/session-thread-1");
        return { verified: true, commitSha: "a".repeat(40), ciStatus: "success" };
      },
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].kind, "review");
  assert.equal(calls[1].kind, "delivery");
  assert.equal(calls[1].input.actorAgentId, "gemini");
  assert.equal(calls[1].input.actorDuty, "review");
  assert.equal(events[0].event, "code-review-approved");
  assert.equal(events[1].event, "delivery-evidence-verified");
});

test("review approve without a delivery receipt records the review gate only", () => {
  const registry = createCollabTaskRegistry();
  registry.captureUserGoal("thread-1", { text: "Deliver the requested outcome" });
  const events = processWorkflowEvidenceOutput({
    agent: "codex",
    duty: "review",
    threadId: "thread-1",
    registry,
    content: [
      "```code_review",
      "verdict: approve",
      "summary: Implementation matches the approved plan.",
      "findings:",
      "  - none",
      "tests:",
      "  - npm test: passed",
      "```",
    ].join("\n"),
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "code-review-approved");
  assert.equal(events[0].payload.verdict, "approve");
  const task = registry.getTask("thread-1");
  assert.equal(task.codeReviewGate.verdict, "approve");
  assert.equal(task.codeReviewGate.reviewedBy, "codex");
  assert.equal(task.deliveryGate, null);
  assert.equal(task.artifacts.codeReview.hash, events[0].payload.reviewEvidenceHash);
});

test("review changes requested persist without pretending the review is missing", () => {
  const registry = createCollabTaskRegistry();
  registry.captureUserGoal("thread-1", { text: "Deliver the requested outcome" });
  const events = processWorkflowEvidenceOutput({
    agent: "codex",
    duty: "review",
    threadId: "thread-1",
    registry,
    content: [
      "```code_review",
      "verdict: changes_requested",
      "summary: Seat duties are not bound together.",
      "findings:",
      "  - P1 deriveThreadParticipation drops Seat to Duty mapping",
      "tests:",
      "  - targeted tests passed",
      "```",
    ].join("\n"),
  });
  assert.equal(events[0].event, "code-review-changes-requested");
  assert.equal(registry.getTask("thread-1").codeReviewGate.verdict, "changes_requested");
});

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createCollabTaskRegistry } = require("../../src/agents/collab-task-registry");
const { processWorkflowEvidenceOutput } = require("../../src/agents/workflow-evidence");

test("Codex solution output becomes the baseline for the implementation workflow", () => {
  const registry = createCollabTaskRegistry();
  const goal = registry.captureUserGoal("thread-1", { text: "Deliver the requested outcome" });
  const events = processWorkflowEvidenceOutput({
    agent: "codex",
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

test("OpenCode delivery output is independently verified before becoming a gate", () => {
  const calls = [];
  const registry = {
    recordOpenCodeDelivery(threadId, input) {
      calls.push({ threadId, input });
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
    agent: "opencode",
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
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.actorAgentId, "opencode");
  assert.equal(events[0].event, "delivery-evidence-verified");
});

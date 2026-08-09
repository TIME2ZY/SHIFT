"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseSolutionBaseline,
  hashSolutionBaseline,
  parseCodeReview,
  hashCodeReview,
  parseDeliveryReceipt,
  validateCommitMessage,
  validatePullRequestDescription,
  parseFinalAcceptance,
  validateFinalAcceptanceAgainstTask,
  hashUserGoal,
  renderOutcomeEvidenceBlock,
} = require("../../src/agents/outcome-evidence-gate");

const GOAL = "Ship the requested workflow with auditable evidence";
const GOAL_HASH = hashUserGoal(GOAL);

function solutionText() {
  return [
    "```solution_baseline",
    `user_goal_hash: ${GOAL_HASH}`,
    "summary: Keep five phases and add evidence gates",
    "constraints:",
    "  - Do not move code review to Codex",
    "non_goals:",
    "  - Do not add a sixth phase",
    "acceptance_criteria:",
    "  - OpenCode creates a verified PR",
    "  - Codex checks the original goal",
    "```",
  ].join("\n");
}

test("solution baseline binds the converged solution to the original goal hash", () => {
  const baseline = parseSolutionBaseline(solutionText());
  assert.equal(baseline.user_goal_hash, GOAL_HASH);
  assert.equal(baseline.acceptance_criteria.length, 2);
  assert.match(hashSolutionBaseline(baseline), /^[a-f0-9]{16}$/);
  assert.equal(parseSolutionBaseline(solutionText().replace(GOAL_HASH, "wrong")), null);
});

test("code review and delivery receipt require structured evidence", () => {
  const review = parseCodeReview(
    [
      "```code_review",
      "verdict: approve",
      "summary: No blocking findings",
      "findings:",
      "  - none",
      "tests:",
      "  - npm run verify:pr: passed",
      "```",
    ].join("\n")
  );
  assert.equal(review.verdict, "approve");
  assert.match(hashCodeReview(review, "a".repeat(40)), /^[a-f0-9]{16}$/);

  const receipt = parseDeliveryReceipt(
    [
      "```delivery_receipt",
      `commit_sha: ${"a".repeat(40)}`,
      "pr_url: https://github.com/acme/repo/pull/7",
      "base_branch: master",
      "verification:",
      "  - npm run verify:pr: passed",
      "```",
    ].join("\n")
  );
  assert.equal(receipt.base_branch, "master");
});

test("commit and PR descriptions enforce auditable conventions", () => {
  assert.equal(
    validateCommitMessage(
      "feat(collab): verify delivery evidence",
      "Bind the reviewed commit to the pull request and CI evidence."
    ).ok,
    true
  );
  assert.equal(validateCommitMessage("update stuff", "short").ok, false);
  assert.equal(
    validatePullRequestDescription(
      "Verify OpenCode delivery evidence",
      [
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
      ].join("\n\n")
    ).ok,
    true
  );
  assert.equal(validatePullRequestDescription("tiny", "no sections").ok, false);
});

test("PR description rejects the retired English section contract", () => {
  const validation = validatePullRequestDescription(
    "Verify OpenCode delivery evidence",
    [
      "## Summary",
      "Goal",
      "## Changes",
      "Change",
      "## Verification",
      "Passed",
      "## Risks",
      "None",
    ].join("\n\n")
  );

  assert.equal(validation.ok, false);
  assert.deepEqual(validation.reasons, [
    "missing_intent",
    "missing_main_flow_impact",
    "missing_path_changes",
    "missing_tests",
    "missing_risks_and_rollback",
  ]);
});

test("final acceptance must match every artifact and pass every criterion", () => {
  const solution = parseSolutionBaseline(solutionText());
  solution.hash = hashSolutionBaseline(solution);
  const task = {
    artifacts: {
      userGoal: { text: GOAL, hash: GOAL_HASH },
      solutionBaseline: solution,
      implementationPlan: { hash: "1".repeat(16) },
    },
    deliveryGate: { commitSha: "a".repeat(40), ciStatus: "success" },
  };
  const acceptance = parseFinalAcceptance(
    [
      "```final_acceptance",
      "verdict: accept",
      `user_goal_hash: ${GOAL_HASH}`,
      `solution_hash: ${solution.hash}`,
      `implementation_plan_hash: ${"1".repeat(16)}`,
      `commit_sha: ${"a".repeat(40)}`,
      "checks:",
      "  - OpenCode creates a verified PR => pass: PR #7 and green CI",
      "  - Codex checks the original goal => pass: goal hash matched",
      "gaps:",
      "  - none",
      "```",
    ].join("\n")
  );
  assert.equal(validateFinalAcceptanceAgainstTask(acceptance, task).ok, true);

  const missingCriterion = { ...acceptance, checks: acceptance.checks.slice(0, 1) };
  assert.equal(
    validateFinalAcceptanceAgainstTask(missingCriterion, task).reason,
    "acceptance_criterion_not_passed"
  );
});

test("agent evidence prompts keep review and final acceptance responsibilities separate", () => {
  const solution = parseSolutionBaseline(solutionText());
  solution.hash = hashSolutionBaseline(solution);
  const task = {
    artifacts: {
      userGoal: { hash: GOAL_HASH },
      solutionBaseline: solution,
      implementationPlan: { hash: "1".repeat(16) },
    },
    deliveryGate: {
      commitSha: "a".repeat(40),
      prUrl: "https://github.com/acme/repo/pull/7",
      ciStatus: "success",
    },
  };
  const codex = renderOutcomeEvidenceBlock("codex", task);
  assert.match(codex, /最初用户目标/);
  assert.match(codex, /final_acceptance/);
  const opencode = renderOutcomeEvidenceBlock("opencode", task, { branch: "codex/session-1" });
  assert.match(opencode, /唯一的代码 reviewer/);
  assert.match(opencode, /delivery_receipt/);
});

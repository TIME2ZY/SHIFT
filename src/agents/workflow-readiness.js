"use strict";

const {
  isImplementationApproved,
  hashUserGoal,
  hashSolutionBaseline,
} = require("./workflow-gates");

function isTaskImplementationApproved(task) {
  const gate = task?.implementationGate;
  const artifactHash = String(task?.artifacts?.implementationPlan?.hash || "");
  return Boolean(isImplementationApproved(gate) && artifactHash === String(gate.planHash || ""));
}

function isTaskSolutionBound(task) {
  const userGoal = task?.artifacts?.userGoal;
  const goalHash = String(userGoal?.hash || "");
  const solution = task?.artifacts?.solutionBaseline;
  if (
    !goalHash ||
    !userGoal?.text ||
    !solution?.hash ||
    String(solution.user_goal_hash || "") !== goalHash
  ) {
    return false;
  }
  try {
    return (
      hashUserGoal(userGoal.text) === goalHash &&
      hashSolutionBaseline(solution) === String(solution.hash)
    );
  } catch {
    return false;
  }
}

function deliveryReadiness(task) {
  if (!task?.artifacts?.userGoal?.hash) return { ok: false, reason: "user_goal_missing" };
  if (!isTaskSolutionBound(task)) {
    return { ok: false, reason: "solution_baseline_missing" };
  }
  if (!isTaskImplementationApproved(task)) {
    return { ok: false, reason: "implementation_plan_not_approved" };
  }
  if (task?.codeReviewGate?.verdict !== "approve") {
    return { ok: false, reason: "code_review_not_approved" };
  }
  const reviewEvidenceHash = String(task.codeReviewGate.evidenceHash || "");
  const reviewArtifact = task?.artifacts?.codeReview;
  if (!reviewArtifact?.hash || String(reviewArtifact.hash) !== reviewEvidenceHash) {
    return { ok: false, reason: "code_review_artifact_missing" };
  }
  if (
    !reviewEvidenceHash ||
    String(task?.deliveryGate?.reviewEvidenceHash || "") !== reviewEvidenceHash
  ) {
    return { ok: false, reason: "delivery_not_bound_to_review" };
  }
  const commitSha = String(task?.deliveryGate?.commitSha || "");
  if (!/^[a-f0-9]{40}$/i.test(commitSha)) {
    return { ok: false, reason: "delivery_commit_missing" };
  }
  if (!task?.deliveryGate?.prUrl) return { ok: false, reason: "delivery_pr_missing" };
  const deliveryArtifact = task?.artifacts?.delivery;
  if (
    !deliveryArtifact ||
    String(deliveryArtifact.reviewEvidenceHash || "") !== reviewEvidenceHash ||
    String(deliveryArtifact.commitSha || "") !== commitSha ||
    String(deliveryArtifact.prUrl || "") !== String(task.deliveryGate.prUrl) ||
    String(deliveryArtifact.ciStatus || "") !== String(task.deliveryGate.ciStatus || "")
  ) {
    return { ok: false, reason: "delivery_artifact_missing" };
  }
  if (task.deliveryGate.ciStatus !== "success") {
    return { ok: false, reason: "ci_not_successful" };
  }
  return { ok: true, reason: null };
}

function completionReadiness(task) {
  const delivery = deliveryReadiness(task);
  if (!delivery.ok) return delivery;
  const commitSha = String(task.deliveryGate.commitSha);
  const goalHash = String(task.artifacts.userGoal.hash);
  const solutionHash = String(task.artifacts.solutionBaseline.hash);
  const implementationPlanHash = String(task.artifacts.implementationPlan.hash);
  const finalArtifact = task?.artifacts?.finalAcceptance;
  if (
    task?.finalGate?.verdict !== "accept" ||
    !finalArtifact?.hash ||
    String(task.finalGate.evidenceHash || "") !== String(finalArtifact.hash) ||
    finalArtifact.verdict !== "accept" ||
    String(finalArtifact.user_goal_hash || "") !== goalHash ||
    String(finalArtifact.solution_hash || "") !== solutionHash ||
    String(finalArtifact.implementation_plan_hash || "") !== implementationPlanHash ||
    String(finalArtifact.commit_sha || "") !== commitSha ||
    String(task.finalGate.acceptedCommitSha || "") !== commitSha ||
    String(task.finalGate.userGoalHash || "") !== goalHash ||
    String(task.finalGate.solutionHash || "") !== solutionHash ||
    String(task.finalGate.implementationPlanHash || "") !== implementationPlanHash
  ) {
    return { ok: false, reason: "final_acceptance_not_bound_to_outcome" };
  }
  return { ok: true, reason: null };
}

function readAcceptanceReadiness(task, readWorkspace) {
  let workspace = null;
  let workspaceError = null;
  try {
    workspace = readWorkspace?.(task.threadId) || null;
  } catch (error) {
    workspaceError = error.message;
  }
  const stored = completionReadiness(task);
  if (!stored.ok) return { ...stored, workspace };
  if (
    !workspace ||
    !Array.isArray(workspace.porcelain) ||
    !/^[a-f0-9]{40}$/i.test(workspace.headSha || "")
  ) {
    return {
      ok: false,
      reason: "acceptance_workspace_unavailable",
      workspace,
      error: workspaceError,
    };
  }
  if (workspace.porcelain.length > 0) {
    return { ok: false, reason: "acceptance_worktree_dirty", workspace };
  }
  if (workspace.headSha !== task.deliveryGate.commitSha) {
    return { ok: false, reason: "acceptance_head_mismatch", workspace };
  }
  return { ok: true, reason: null, workspace };
}

module.exports = {
  isTaskImplementationApproved,
  isTaskSolutionBound,
  deliveryReadiness,
  readAcceptanceReadiness,
};

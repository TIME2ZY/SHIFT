/**
 * Session-scoped task card projection.
 *
 * Collaboration facts and Duty bindings come from SQLite. Workspace evidence
 * comes from the bound Git worktree. This module is read-only and never writes
 * either truth source.
 */

"use strict";

function projectCollaboration(task, permission = null, context = {}) {
  if (!task) return null;
  const implPermission = permission && typeof permission === "object" ? permission : {};
  const bindings = Array.isArray(context.bindings) ? context.bindings : [];
  const seats = Array.isArray(context.seats) ? context.seats : [];
  const currentBinding = bindings.at(-1) || null;
  const currentSeat = currentBinding
    ? seats.find((seat) => seat.seatId === currentBinding.seatId) || null
    : null;
  const implementationGate = task.implementationGate || null;
  const plan = task.artifacts?.implementationPlan || null;
  const reviewGate = task.codeReviewGate || null;
  const deliveryGate = task.deliveryGate || null;
  const implementation = projectImplementation(implementationGate, plan, implPermission);
  const blocker = deriveBlocker(task, implementation);

  return {
    status: nullableString(task.taskStatus) || (task.phase === "done" ? "accepted" : "active"),
    phase: String(task.phase || task.state || "discuss"),
    goalOriginal: nullableString(task.goalOriginal || task.artifacts?.userGoal?.text || task.goal),
    goalNormalized: nullableString(task.goalNormalized || task.goal),
    currentSeat: projectSeat(currentSeat, currentBinding),
    currentDuty: nullableString(currentBinding?.duty),
    currentSkill: nullableString(currentBinding?.skillName),
    enforcementLevel: nullableString(currentBinding?.enforcementLevel),
    updatedAt: nullableString(task.updatedAt),
    blocker,
    evidence: projectEvidence(deliveryGate, context.workspace),
    reviewMode: deriveReviewMode(bindings, reviewGate),
    nextAction: deriveNextAction(currentBinding?.duty, task, blocker),
  };
}

function projectSeats(seats) {
  if (!Array.isArray(seats)) return [];
  return seats
    .filter((seat) => seat?.enabled !== false)
    .map((seat) => ({
      seatId: nullableString(seat.seatId),
      providerId: nullableString(seat.providerId),
      label: nullableString(seat.label),
    }))
    .filter((seat) => seat.seatId && seat.providerId);
}

function projectSeat(seat, binding) {
  if (!binding?.seatId) return null;
  return {
    seatId: String(binding.seatId),
    providerId: nullableString(seat?.providerId),
    label: nullableString(seat?.label),
  };
}

function projectImplementation(gate, plan, permission) {
  if (!gate) {
    return {
      status: null,
      allowed: null,
      reason: null,
      planHash: null,
      summary: nullableString(plan?.summary),
    };
  }
  const allowed = permission.allowed === true;
  return {
    status: nullableString(permission.status || gate.status),
    allowed,
    reason: allowed ? null : nullableString(permission.reason),
    planHash: nullableString(permission.planHash || gate.planHash),
    summary: nullableString(plan?.summary),
  };
}

function projectEvidence(deliveryGate, workspace) {
  const workspaceStatus = workspace && typeof workspace === "object" ? workspace : {};
  const dirtyFileCount = Array.isArray(workspaceStatus.porcelain)
    ? workspaceStatus.porcelain.length
    : null;
  return {
    dirtyFileCount,
    headSha: nullableString(workspaceStatus.headSha),
    commitSha: nullableString(deliveryGate?.commitSha),
    prUrl: nullableString(deliveryGate?.prUrl),
    ciStatus: nullableString(deliveryGate?.ciStatus),
  };
}

function deriveBlocker(task, implementation) {
  const phase = String(task.phase || task.state || "");
  if (phase === "done" || task.taskStatus === "accepted") return null;
  if (task.taskStatus === "waiting_human") {
    return { type: "waiting_human", reason: "human_input_required" };
  }
  if (implementation.status && implementation.allowed === false && implementation.reason) {
    const reason = implementation.reason;
    return {
      type: reason === "implementation_plan_not_approved" ? "waiting_approval" : "missing_evidence",
      reason,
    };
  }
  if (phase === "review" && !task.codeReviewGate) {
    return { type: "missing_evidence", reason: "code_review_pending" };
  }
  if (phase === "deliver") {
    if (!task.deliveryGate) {
      return { type: "missing_evidence", reason: "delivery_evidence_missing" };
    }
    if (task.deliveryGate.ciStatus && task.deliveryGate.ciStatus !== "success") {
      return { type: "missing_evidence", reason: "ci_not_successful" };
    }
    if (!task.finalGate || task.finalGate.verdict !== "accept") {
      return { type: "waiting_human", reason: "final_acceptance_missing" };
    }
  }
  return null;
}

function deriveReviewMode(bindings, reviewGate) {
  if (!reviewGate) return "pending";
  const reviewer = [...bindings]
    .reverse()
    .find((binding) => ["review", "deliver"].includes(binding?.duty));
  if (!reviewer) return "pending";
  const reviewerIndex = bindings.indexOf(reviewer);
  const implementer = bindings
    .slice(0, reviewerIndex)
    .reverse()
    .find((binding) => ["implement", "fix"].includes(binding?.duty));
  if (!implementer) return "pending";
  return implementer.seatId === reviewer.seatId ? "same_seat" : "other_seat";
}

function deriveNextAction(duty, task, blocker) {
  const blockerActions = {
    implementation_plan_not_approved: "请批准实现方案后继续。",
    implementation_plan_missing: "请补充可执行的实现方案。",
    implementation_plan_artifact_missing: "请补充方案正文。",
    code_review_pending: "请完成代码审查并记录结论。",
    delivery_evidence_missing: "请补充 commit、PR 和 CI 交付证据。",
    ci_not_successful: "请修复 CI 后重新核验交付。",
    final_acceptance_missing: "请核对证据并完成最终验收。",
    human_input_required: "等待用户提供信息或作出决定。",
  };
  if (blocker?.reason && blockerActions[blocker.reason]) return blockerActions[blocker.reason];
  if (task.phase === "done" || task.taskStatus === "accepted") return "任务已验收。";
  const dutyActions = {
    discuss: "收敛目标并确认解决方向。",
    plan: "形成可执行方案并提交批准。",
    implement: "完成实现并留下验证证据。",
    fix: "修复审查发现并重新验证。",
    review: "审查实现与验证证据。",
    deliver: "核验 commit、PR 和 CI 交付证据。",
    accept: "核对目标与交付证据并验收。",
    recall: "检索与当前目标相关的上下文。",
  };
  return dutyActions[duty] || "继续推进当前目标。";
}

function nullableString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

module.exports = { projectCollaboration, projectSeats };

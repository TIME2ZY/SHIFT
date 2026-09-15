/**
 * A2A route policy for the collaboration task registry.
 *
 * Four routing decisions: which phase an accepted route moves the task to,
 * and whether evidence routing, implementation routing, or a review would be
 * redundant. The phase ladder is PHASE_BY_INTENT with an explicit default.
 * Route decisions read but never persist; noteAcceptedRoute is the sole
 * exception and the only writer here.
 */

"use strict";

const { normalizeIntent } = require("./handoff");
const {
  isTaskImplementationApproved,
  isTaskSolutionBound,
  deliveryReadiness,
} = require("./workflow-readiness");
const { IMPLEMENTATION_GATE_STATUS } = require("./workflow-gates");
const { COLLAB_TASK_PHASE: STATE } = require("../shared/collab-contracts");

/** Intent → phase. Intents absent here (e.g. recall) keep the current phase. */
const PHASE_BY_INTENT = Object.freeze({
  discuss: STATE.DISCUSS,
  implement: STATE.IMPLEMENT,
  fix: STATE.IMPLEMENT,
  review: STATE.REVIEW,
  deliver: STATE.DELIVER,
  accept: STATE.DELIVER,
});

/**
 * @param {object} core registry core (reads: getTask, getOrCreateTask, persist,
 *   hashEvidence, isReviewDuty, isImplementationDuty)
 * @param {object} deps sibling modules (reads: requireImplementationPlan,
 *   implementationPermission, invalidateDownstreamGates)
 * @returns {{ noteAcceptedRoute, shouldBlockEvidenceRoute,
 *   shouldBlockImplementationRoute, shouldSkipRedundantReview }}
 */
function createRoutePolicy(core, deps) {
  const {
    getTask,
    getOrCreateTask,
    persist,
    hashEvidence,
    isReviewDuty,
    isImplementationDuty,
    canApprovePlan,
  } = core;
  const { requireImplementationPlan, implementationPermission, invalidateDownstreamGates } = deps;

  /**
   * Approve a pending plan without persisting, so a route may carry the
   * approval into its own single write.
   */
  function approveImplementationPlanInline(task, input = {}) {
    const actor = String(input.actorAgentId || "").toLowerCase();
    if (!canApprovePlan(input.actorDuty)) {
      return { approved: false, reason: "plan_approval_requires_discuss_or_accept_duty" };
    }
    const gate = task?.implementationGate;
    if (!gate?.planHash || gate.status !== IMPLEMENTATION_GATE_STATUS.PENDING_APPROVAL) {
      return { approved: false, reason: "implementation_plan_not_pending" };
    }
    task.implementationGate = {
      ...gate,
      status: IMPLEMENTATION_GATE_STATUS.APPROVED,
      approvedPlanHash: gate.planHash,
      approvedBy: actor,
      approvedAt: new Date().toISOString(),
    };
    task.approvalHash = gate.planHash;
    return { approved: true, reason: null, planHash: gate.planHash };
  }

  /** Resolve the phase one accepted route moves the task to. */
  function resolveNextPhase(intent, toDuty, useWorktree, previous) {
    if (!intent) {
      if (isReviewDuty(toDuty)) return STATE.REVIEW;
      if (useWorktree || isImplementationDuty(toDuty)) return STATE.IMPLEMENT;
      return previous;
    }
    if (intent === "plan") {
      return isImplementationDuty(toDuty) ? STATE.IMPLEMENT : STATE.DISCUSS;
    }
    return PHASE_BY_INTENT[intent] || previous;
  }

  /** Infer and persist the phase transition caused by one accepted A2A route. */
  function noteAcceptedRoute(input = {}) {
    const threadId = input.threadId;
    if (!threadId) return null;
    const task = getOrCreateTask(threadId);
    const from = String(input.fromAgent || "").toLowerCase();
    const to = String(input.toAgent || "").toLowerCase();
    const intent = normalizeIntent(input.intent) || "";
    const fromDuty = String(input.fromDuty || "").toLowerCase();
    const toDuty = String(input.toDuty || intent || "").toLowerCase();
    const contentHash = input.contentHash || null;
    const useWorktree = Boolean(input.useWorktree);
    const handoff = input.handoff || {};
    const evidenceHash = hashEvidence({
      contentHash,
      goal: handoff.goal,
      what: handoff.what,
      diffHash: input.diffHash,
      testHash: input.testHash,
    });

    task.lastFrom = from || null;
    task.lastTo = to || null;
    task.contentHash = contentHash || task.contentHash;
    let implementationApproved = false;

    if (intent === "plan" && isImplementationDuty(toDuty)) {
      requireImplementationPlan(task, {
        requestHash: contentHash,
        requestedBy: from || null,
        force: true,
      });
    }
    if (intent === "implement" && isImplementationDuty(toDuty)) {
      const approval = approveImplementationPlanInline(task, {
        actorAgentId: from,
        actorDuty: fromDuty,
      });
      if (!approval.approved && !isTaskImplementationApproved(task)) {
        throw new Error(`Implementation route rejected: ${approval.reason}`);
      }
      implementationApproved = approval.approved;
    }

    const previous = task.phase;
    const next = resolveNextPhase(intent, toDuty, useWorktree, previous);

    invalidateDownstreamGates(task, previous, next, { intent, toDuty });
    task.phase = next;
    task.state = next;

    const event = {
      type: implementationApproved
        ? "implementation_plan_approved"
        : next === previous
          ? "route"
          : "transition",
      from: previous,
      to: next,
      actorAgentId: from || null,
      actorId: input.fromSeatId || from || "system",
      intent: intent || null,
      contentHash,
      targetAgentId: to || null,
      duty: fromDuty || null,
      targetDuty: toDuty || null,
      evidenceHash,
      planHash: implementationApproved ? task.implementationGate?.planHash || null : null,
    };
    return persist(task, event);
  }

  function shouldBlockEvidenceRoute(input = {}) {
    const intent = normalizeIntent(input.intent) || "";
    const task = getTask(input.threadId);
    if (["plan", "implement", "fix"].includes(intent)) {
      if (!task?.artifacts?.userGoal?.hash) {
        return { skip: true, reason: "user_goal_missing", state: task?.phase || STATE.DISCUSS };
      }
      if (!isTaskSolutionBound(task)) {
        return {
          skip: true,
          reason: "solution_baseline_missing",
          state: task?.phase || STATE.DISCUSS,
        };
      }
    }
    if (intent === "accept") {
      const readiness = deliveryReadiness(task);
      if (!readiness.ok) {
        return { skip: true, reason: readiness.reason, state: task?.phase || STATE.DELIVER };
      }
    }
    return { skip: false };
  }

  function shouldBlockImplementationRoute(input = {}) {
    const task = getTask(input.threadId);
    if (task?.implementationGate?.loopDetected) {
      return {
        skip: true,
        reason: "duplicate_plan_loop_detected",
        state: task?.phase || STATE.IMPLEMENT,
        planHash: task?.implementationGate?.planHash,
      };
    }
    const intent = normalizeIntent(input.intent) || "";
    if (!["implement", "fix"].includes(input.toDuty) || !["implement", "fix"].includes(intent)) {
      return { skip: false };
    }

    const permission = implementationPermission(input.threadId);
    if (permission.allowed) return { skip: false, state: STATE.IMPLEMENT };
    if (
      canApprovePlan(input.fromDuty) &&
      permission.status === "pending_approval" &&
      permission.planHash &&
      permission.artifactBound
    ) {
      return { skip: false, state: STATE.IMPLEMENT, pendingApproval: true };
    }
    return {
      skip: true,
      reason: permission.reason,
      state: getTask(input.threadId)?.phase || STATE.IMPLEMENT,
      planHash: permission.planHash,
    };
  }

  /** Skip re-review only when the exact evidence was already approved. */
  function shouldSkipRedundantReview(input = {}) {
    const task = getTask(input.threadId);
    if (!task) return { skip: false };
    const intent = normalizeIntent(input.intent) || "";
    if (input.toDuty !== "review" && intent !== "review") return { skip: false };

    if (task.phase === STATE.DONE && !input.force) {
      return { skip: true, reason: "task_done", state: task.phase };
    }
    if (!task.codeReviewGate || task.codeReviewGate.verdict !== "approve") {
      return { skip: false, state: task.phase };
    }

    const evidenceHash = hashEvidence({
      contentHash: input.contentHash,
      goal: input.handoff?.goal,
      what: input.handoff?.what,
      diffHash: input.diffHash,
      testHash: input.testHash,
    });
    if (task.codeReviewGate.evidenceHash === evidenceHash) {
      return {
        skip: true,
        reason: "already_approved_same_evidence",
        state: task.phase,
        approvalHash: evidenceHash,
      };
    }
    return { skip: false, state: task.phase };
  }

  return {
    noteAcceptedRoute,
    shouldBlockEvidenceRoute,
    shouldBlockImplementationRoute,
    shouldSkipRedundantReview,
  };
}

module.exports = { createRoutePolicy, PHASE_BY_INTENT };

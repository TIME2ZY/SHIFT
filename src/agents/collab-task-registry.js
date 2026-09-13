/**
 * Collaboration workflow registry.
 *
 * The default export remains an in-memory singleton for isolated callers and
 * tests. Server requests create a registry backed by SQLite so phase/gate
 * decisions survive process restarts.
 */

"use strict";

const crypto = require("node:crypto");
const { createTaskUpdates } = require("./task-updates");
const { COLLAB_TASK_STATES } = require("../shared/collab-contracts");
const { normalizeIntent } = require("./handoff");
const {
  IMPLEMENTATION_GATE_STATUS,
  parseImplementationPlan,
  validateImplementationPlan,
  hashImplementationPlan,
  hashIsomorphicPlan,
  parseSolutionBaseline,
  hashSolutionBaseline,
  parseCodeReview,
  hashCodeReview,
  parseDeliveryReceipt,
  validateVerifiedDelivery,
  parseFinalAcceptance,
  validateFinalAcceptanceAgainstTask,
} = require("./workflow-gates");
const { ENV } = require("../shared/brand");

const {
  isTaskImplementationApproved,
  isTaskSolutionBound,
  deliveryReadiness,
  readAcceptanceReadiness,
} = require("./workflow-readiness");

const STATE = Object.freeze({
  DISCUSS: "discuss",
  IMPLEMENT: "implement",
  REVIEW: "review",
  DELIVER: "deliver",
  DONE: "done",
});

function isReviewDuty(duty) {
  return String(duty || "").toLowerCase() === "review";
}

function isImplementationDuty(duty) {
  return ["plan", "implement", "fix"].includes(String(duty || "").toLowerCase());
}

function isDiscussDuty(duty) {
  return String(duty || "").toLowerCase() === "discuss";
}

function isDeliverDuty(duty) {
  return String(duty || "").toLowerCase() === "deliver";
}

function isAcceptanceDuty(duty) {
  return String(duty || "").toLowerCase() === "accept";
}

function canApprovePlan(duty) {
  return ["discuss", "accept"].includes(String(duty || "").toLowerCase());
}

function emptyTask(threadId) {
  const now = new Date().toISOString();
  return {
    threadId,
    phase: STATE.DISCUSS,
    state: STATE.DISCUSS,
    goal: null,
    contentHash: null,
    approvalHash: null,
    lastFrom: null,
    lastTo: null,
    artifacts: {},
    implementationGate: null,
    codeReviewGate: null,
    deliveryGate: null,
    finalGate: null,
    createdAt: now,
    updatedAt: now,
    version: 0,
    history: [],
  };
}

/** Hash a handoff / review evidence blob for approval binding. */
function hashEvidence(parts = {}) {
  const payload = [
    String(parts.contentHash || ""),
    String(parts.goal || ""),
    String(parts.what || ""),
    String(parts.diffHash || ""),
    String(parts.testHash || ""),
  ].join("\n");
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function createCollabTaskRegistry(options = {}) {
  const repository = options.repository || null;
  const tasksByThread = new Map();

  function getTask(threadId) {
    if (!threadId) return null;
    if (repository) return repository.get(String(threadId));
    return tasksByThread.get(String(threadId)) || null;
  }

  function getOrCreateTask(threadId) {
    if (!threadId) return emptyTask("");
    return getTask(threadId) || emptyTask(String(threadId));
  }

  function persist(task, event = null) {
    task.phase = normalizePhase(task.phase || task.state);
    task.state = task.phase;
    task.updatedAt = new Date().toISOString();
    const recorded = event ? decorateCollabEvent(event) : null;
    if (repository) return repository.save(task, recorded);

    if (recorded) {
      task.history = Array.isArray(task.history) ? task.history : [];
      task.history.push({ ...recorded, at: recorded.at || new Date().toISOString() });
      if (task.history.length > 40) task.history.shift();
    }
    task.version = Number(task.version || 0) + 1;
    tasksByThread.set(task.threadId, task);
    return { ...task, history: task.history.slice() };
  }

  const { captureUserGoal, submitTaskUpdate } = createTaskUpdates({
    getOrCreateTask,
    persist,
    resetOutcomeEvidence,
  });

  function submitSolutionBaseline(threadId, input = {}) {
    if (!threadId) return { accepted: false, reason: "missing_thread" };
    const actorAgentId = String(input.actorAgentId || "").toLowerCase();
    if (!["discuss", "plan", "accept"].includes(String(input.actorDuty || "").toLowerCase())) {
      return { accepted: false, reason: "solution_requires_discuss_plan_or_accept_duty" };
    }
    const baseline = input.baseline || parseSolutionBaseline(input.content);
    if (!baseline) return { accepted: false, reason: "invalid_or_missing_solution_baseline" };
    const task = getOrCreateTask(threadId);
    const goalHash = String(task.artifacts?.userGoal?.hash || "");
    if (!goalHash) return { accepted: false, reason: "user_goal_missing" };
    if (String(baseline.user_goal_hash || "") !== goalHash) {
      return { accepted: false, reason: "solution_user_goal_mismatch" };
    }
    const solutionHash = hashSolutionBaseline(baseline);
    if (task.artifacts?.solutionBaseline?.hash === solutionHash) {
      return { accepted: true, reused: true, solutionHash, task };
    }
    const previousHash = task.artifacts?.solutionBaseline?.hash || null;
    if (previousHash && previousHash !== solutionHash) invalidateAfterSolutionRevision(task);
    task.artifacts = {
      ...(task.artifacts || {}),
      solutionBaseline: {
        ...baseline,
        hash: solutionHash,
        submittedBy: actorAgentId,
        submittedAt: new Date().toISOString(),
      },
    };
    const saved = persist(task, {
      type: "solution_baseline_submitted",
      from: task.phase,
      to: task.phase,
      actorAgentId,
      intent: "plan",
      goalHash,
      solutionHash,
    });
    return { accepted: true, reused: false, solutionHash, task: saved };
  }

  function recordCodeReview(threadId, input = {}) {
    if (typeof input.invocationId !== "string" || !input.invocationId.trim())
      return { accepted: false, reason: "missing_invocation" };
    if (!threadId) return { accepted: false, reason: "missing_thread" };
    const actorAgentId = String(input.actorAgentId || "").toLowerCase();
    const actorDuty = String(input.actorDuty || "").toLowerCase();
    if (!isReviewDuty(actorDuty) && !isDeliverDuty(actorDuty)) {
      return { accepted: false, reason: "review_requires_review_or_deliver_duty" };
    }
    const review = input.review || parseCodeReview(input.content);
    if (!review) return { accepted: false, reason: "invalid_or_missing_code_review" };
    const task = getTask(threadId);
    if (!task) return { accepted: false, reason: "collaboration_task_missing" };

    if (task.codeReviewGate?.sourceInvocationId === input.invocationId) {
      return {
        accepted: !task.codeReviewGate.loopDetected,
        loopDetected: Boolean(task.codeReviewGate.loopDetected),
        reused: true,
        verdict: task.codeReviewGate.verdict,
        reviewEvidenceHash: task.codeReviewGate.evidenceHash,
        task,
      };
    }
    const reviewEvidenceHash = hashCodeReview(review);
    const maxRepeats = Number(input.maxReviewRepeats || process.env[ENV.MAX_IDENTICAL_PLANS] || 3);
    const isSameReview = Boolean(
      task.codeReviewGate?.evidenceHash === reviewEvidenceHash &&
      task.codeReviewGate?.verdict === review.verdict &&
      (!input.progressKey || task.codeReviewGate?.progressKey === input.progressKey)
    );
    const consecutiveRepeats = isSameReview
      ? (Number(task.codeReviewGate?.consecutiveRepeats) || 1) + 1
      : 1;

    if (isSameReview && consecutiveRepeats > maxRepeats) {
      task.codeReviewGate = {
        ...(task.codeReviewGate || {}),
        evidenceHash: reviewEvidenceHash,
        verdict: review.verdict,
        sourceInvocationId: input.invocationId,
        progressKey: input.progressKey || null,
        consecutiveRepeats,
        loopDetected: true,
        loopDetectedAt: new Date().toISOString(),
      };
      const saved = persist(task, {
        type: "code_review_loop_detected",
        from: task.phase,
        to: task.phase,
        actorAgentId,
        intent: "review",
        reviewEvidenceHash,
        verdict: review.verdict,
        consecutiveRepeats,
      });
      return {
        accepted: false,
        loopDetected: true,
        reason: "duplicate_review_loop_detected",
        verdict: review.verdict,
        reviewEvidenceHash,
        consecutiveRepeats,
        task: saved,
      };
    }

    if (isSameReview) {
      task.codeReviewGate = {
        ...task.codeReviewGate,
        sourceInvocationId: input.invocationId,
        progressKey: input.progressKey || null,
        consecutiveRepeats,
      };
      const saved = persist(task);
      return {
        accepted: true,
        reused: true,
        verdict: review.verdict,
        reviewEvidenceHash,
        consecutiveRepeats,
        task: saved,
      };
    }

    const reviewedAt = new Date().toISOString();
    task.artifacts = {
      ...(task.artifacts || {}),
      codeReview: {
        ...review,
        hash: reviewEvidenceHash,
        reviewedBy: actorAgentId,
        reviewedAt,
      },
    };
    if (review.verdict === "changes_requested") {
      delete task.artifacts.delivery;
      delete task.artifacts.finalAcceptance;
      delete task.artifacts.acceptanceDecision;
      task.deliveryGate = null;
      task.finalGate = null;
      task.approvalHash = null;
    }
    task.taskStatus = "active";
    task.codeReviewGate = {
      verdict: review.verdict,
      evidenceHash: reviewEvidenceHash,
      sourceInvocationId: input.invocationId,
      progressKey: input.progressKey || null,
      consecutiveRepeats: 1,
      loopDetected: false,
      reviewedBy: actorAgentId,
      reviewedAt,
    };
    const saved = persist(task, {
      type: review.verdict === "approve" ? "code_review_approved" : "code_review_changes_requested",
      from: task.phase,
      to: task.phase,
      actorAgentId,
      actorId: input.fromSeatId || actorAgentId,
      duty: actorDuty,
      intent: "review",
      verdict: review.verdict,
      reviewEvidenceHash,
      consecutiveRepeats: 1,
    });
    return {
      accepted: true,
      reused: false,
      verdict: review.verdict,
      reviewEvidenceHash,
      consecutiveRepeats: 1,
      task: saved,
    };
  }

  function recordDeliveryEvidence(threadId, input = {}) {
    if (!threadId) return { accepted: false, reason: "missing_thread" };
    const actorAgentId = String(input.actorAgentId || "").toLowerCase();
    const actorDuty = String(input.actorDuty || "").toLowerCase();
    if (!isReviewDuty(actorDuty) && !isDeliverDuty(actorDuty)) {
      return { accepted: false, reason: "delivery_requires_review_or_deliver_duty" };
    }
    const review = input.review || parseCodeReview(input.content);
    const receipt = input.receipt || parseDeliveryReceipt(input.content);
    if (!review) return { accepted: false, reason: "invalid_or_missing_code_review" };
    if (review.verdict !== "approve") {
      return { accepted: false, reason: "code_review_not_approved" };
    }
    if (!receipt) return { accepted: false, reason: "invalid_or_missing_delivery_receipt" };
    const verification = input.verification || null;
    const verified = validateVerifiedDelivery(verification, receipt);
    if (!verified.ok) return { accepted: false, reason: verified.reason };

    const task = getTask(threadId);
    if (!task) return { accepted: false, reason: "collaboration_task_missing" };
    if (!isTaskImplementationApproved(task)) {
      return { accepted: false, reason: "implementation_plan_not_approved" };
    }
    if (!isTaskSolutionBound(task)) {
      return { accepted: false, reason: "solution_baseline_missing" };
    }
    const reviewEvidenceHash = hashCodeReview(review, verification.commitSha);
    if (
      task.codeReviewGate?.evidenceHash === reviewEvidenceHash &&
      task.deliveryGate?.commitSha === verification.commitSha &&
      task.deliveryGate?.ciStatus === verification.ciStatus
    ) {
      return {
        accepted: true,
        reused: true,
        readyForAcceptance: verification.ciStatus === "success",
        reason: verification.ciStatus === "success" ? null : "ci_not_successful",
        reviewEvidenceHash,
        task,
      };
    }
    task.artifacts = {
      ...(task.artifacts || {}),
      codeReview: {
        ...review,
        hash: reviewEvidenceHash,
        commitSha: verification.commitSha,
        reviewedBy: actorAgentId,
        reviewedAt: new Date().toISOString(),
      },
      delivery: {
        ...receipt,
        ...verification,
        reviewEvidenceHash,
      },
    };
    delete task.artifacts.finalAcceptance;
    delete task.artifacts.acceptanceDecision;
    task.taskStatus = "active";
    task.codeReviewGate = {
      ...task.codeReviewGate,
      sourceInvocationId: input.invocationId || task.codeReviewGate?.sourceInvocationId || null,
      verdict: "approve",
      evidenceHash: reviewEvidenceHash,
      commitSha: verification.commitSha,
      reviewedBy: actorAgentId,
      reviewedAt: new Date().toISOString(),
    };
    task.deliveryGate = {
      reviewEvidenceHash,
      commitSha: verification.commitSha,
      branch: verification.branch,
      baseBranch: verification.baseBranch,
      prUrl: verification.prUrl,
      prNumber: verification.prNumber,
      ciStatus: verification.ciStatus,
      verifiedBy: actorAgentId,
      verifiedAt: verification.verifiedAt || new Date().toISOString(),
    };
    task.finalGate = null;
    task.approvalHash = reviewEvidenceHash;
    const previous = task.phase;
    task.phase = STATE.DELIVER;
    task.state = STATE.DELIVER;
    const saved = persist(task, {
      type: "delivery_evidence_verified",
      from: previous,
      to: STATE.DELIVER,
      actorAgentId,
      intent: "deliver",
      reviewEvidenceHash,
      commitSha: verification.commitSha,
      prUrl: verification.prUrl,
      ciStatus: verification.ciStatus,
    });
    return {
      accepted: true,
      readyForAcceptance: verification.ciStatus === "success",
      reason: verification.ciStatus === "success" ? null : "ci_not_successful",
      reviewEvidenceHash,
      task: saved,
    };
  }

  function submitFinalAcceptance(threadId, input = {}) {
    if (!threadId) return { accepted: false, reason: "missing_thread" };
    const actorAgentId = String(input.actorAgentId || "").toLowerCase();
    if (!isAcceptanceDuty(input.actorDuty)) {
      return { accepted: false, reason: "final_acceptance_requires_accept_duty" };
    }
    const acceptance = input.acceptance || parseFinalAcceptance(input.content);
    if (!acceptance) return { accepted: false, reason: "invalid_or_missing_final_acceptance" };
    const task = getTask(threadId);
    if (!task) return { accepted: false, reason: "collaboration_task_missing" };
    if (!isTaskSolutionBound(task)) {
      return { accepted: false, reason: "solution_baseline_missing" };
    }
    const validation = validateFinalAcceptanceAgainstTask(acceptance, task);
    if (!validation.ok) return { accepted: false, reason: validation.reason };

    const acceptanceHash = hashEvidence({
      goal: acceptance.user_goal_hash,
      what: JSON.stringify(acceptance.checks),
      diffHash: acceptance.commit_sha,
      testHash: acceptance.solution_hash,
    });
    const requestedVerdict =
      String(acceptance.verdict || "").toLowerCase() === "reject" ? "rejected" : "accepted";
    task.artifacts = {
      ...(task.artifacts || {}),
      finalAcceptance: {
        ...acceptance,
        hash: acceptanceHash,
        acceptedBy: actorAgentId,
        acceptedAt: new Date().toISOString(),
      },
    };
    if (task.phase === STATE.DONE && requestedVerdict !== "accepted") {
      task.phase = STATE.DELIVER;
      task.state = STATE.DELIVER;
    }
    task.finalGate = {
      verdict: acceptance.verdict,
      evidenceHash: acceptanceHash,
      userGoalHash: acceptance.user_goal_hash,
      solutionHash: acceptance.solution_hash,
      implementationPlanHash: acceptance.implementation_plan_hash,
      acceptedCommitSha: acceptance.commit_sha,
      acceptedBy: actorAgentId,
      acceptedAt: new Date().toISOString(),
    };
    const readiness =
      requestedVerdict === "accepted"
        ? readAcceptanceReadiness(task, options.readWorkspace)
        : { ok: true, reason: null, workspace: null };
    const verdict =
      requestedVerdict === "accepted" && !readiness.ok ? "incomplete" : requestedVerdict;
    const reason =
      verdict === "accepted"
        ? null
        : requestedVerdict === "accepted"
          ? readiness.reason
          : "accept_duty_rejected";
    const goalHash = String(task.artifacts?.userGoal?.hash || "");
    const planHash = String(task.artifacts?.implementationPlan?.hash || "") || null;
    const commitSha = String(task.deliveryGate?.commitSha || "") || null;
    const previousDecision = task.artifacts?.acceptanceDecision;
    if (
      previousDecision?.verdict === verdict &&
      previousDecision?.goalHash === goalHash &&
      previousDecision?.planHash === planHash &&
      previousDecision?.commitSha === commitSha &&
      previousDecision?.reason === reason &&
      previousDecision?.actorKind === "seat" &&
      previousDecision?.actorId === actorAgentId
    ) {
      return {
        accepted: true,
        reused: true,
        recorded: true,
        readiness,
        verdict,
        reason,
        acceptanceHash,
        taskStatus: task.taskStatus,
        task,
      };
    }

    const decidedAt = new Date().toISOString();
    task.artifacts.acceptanceDecision = {
      verdict,
      requestedVerdict,
      reason,
      goalHash,
      planHash,
      commitSha,
      actorKind: "seat",
      actorId: actorAgentId,
      decidedAt,
    };
    const previous = task.phase;
    if (verdict === "accepted") {
      task.phase = STATE.DONE;
      task.state = STATE.DONE;
      task.taskStatus = "accepted";
    } else if (verdict === "rejected") {
      if (task.phase === STATE.DONE) {
        task.phase = STATE.DELIVER;
        task.state = STATE.DELIVER;
      }
      task.taskStatus = "rejected";
    } else {
      if (task.phase === STATE.DONE) {
        task.phase = STATE.DELIVER;
        task.state = STATE.DELIVER;
      }
      task.taskStatus = "active";
    }
    const saved = persist(task, {
      type: "final_acceptance_decided",
      from: previous,
      to: task.phase,
      actorKind: "seat",
      actorId: actorAgentId,
      actorAgentId,
      duty: "accept",
      intent: "accept",
      verdict,
      requestedVerdict,
      reason,
      acceptanceHash,
      goalHash,
      planHash,
      commitSha,
    });
    return {
      accepted: true,
      reused: false,
      recorded: true,
      readiness,
      verdict,
      reason,
      acceptanceHash,
      taskStatus: saved.taskStatus,
      task: saved,
    };
  }

  function acceptanceReadiness(threadId) {
    const task = getTask(threadId);
    if (!task) return { ok: false, reason: "collaboration_task_missing" };
    return readAcceptanceReadiness(task, options.readWorkspace);
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

  function requireImplementationPlan(task, input = {}) {
    const requestHash = String(input.requestHash || "").trim() || null;
    const current = task.implementationGate;
    if (current && !input.force && (!requestHash || requestHash === current.requestHash)) {
      return false;
    }

    task.implementationGate = {
      status: IMPLEMENTATION_GATE_STATUS.REQUIRED,
      requestHash,
      planHash: null,
      isomorphicHash: null,
      consecutiveRepeats: 0,
      loopDetected: false,
      approvedPlanHash: null,
      requestedBy: input.requestedBy || null,
      requestedAt: new Date().toISOString(),
      proposedBy: null,
      proposedAt: null,
      approvedBy: null,
      approvedAt: null,
    };
    task.artifacts = { ...(task.artifacts || {}) };
    delete task.artifacts.implementationPlan;
    delete task.artifacts.progress;
    delete task.artifacts.codeReview;
    delete task.artifacts.delivery;
    delete task.artifacts.finalAcceptance;
    delete task.artifacts.acceptanceDecision;
    task.taskStatus = "active";
    task.codeReviewGate = null;
    task.deliveryGate = null;
    task.finalGate = null;
    task.approvalHash = null;
    return true;
  }

  function ensureImplementationPlanRequired(threadId, input = {}) {
    if (!threadId) return null;
    const task = getOrCreateTask(threadId);
    const changed = requireImplementationPlan(task, input);
    if (!changed) return task;
    task.phase = STATE.IMPLEMENT;
    task.state = STATE.IMPLEMENT;
    return persist(task, {
      type: "implementation_plan_required",
      from: task.phase,
      to: task.phase,
      actorAgentId: input.requestedBy || null,
      intent: "plan",
      requestHash: task.implementationGate.requestHash,
    });
  }

  function submitImplementationPlan(threadId, input = {}) {
    if (typeof input.invocationId !== "string" || !input.invocationId.trim())
      return { accepted: false, reason: "missing_invocation" };
    if (!threadId) return { accepted: false, reason: "missing_thread" };
    const actorAgentId = String(input.actorAgentId || "").toLowerCase();
    if (!isImplementationDuty(input.actorDuty)) {
      return { accepted: false, reason: "plan_requires_plan_implement_or_fix_duty" };
    }
    const plan = input.plan || parseImplementationPlan(input.content);
    if (!plan || !validateImplementationPlan(plan).ok) {
      return { accepted: false, reason: "invalid_or_missing_implementation_plan" };
    }

    const task = getOrCreateTask(threadId);
    if (!task.implementationGate) requireImplementationPlan(task, { requestedBy: actorAgentId });
    if (task.implementationGate?.sourceInvocationId === input.invocationId) {
      return {
        accepted: !task.implementationGate.loopDetected,
        loopDetected: Boolean(task.implementationGate.loopDetected),
        reused: true,
        planHash: task.implementationGate.planHash,
        task,
      };
    }
    const planHash = hashImplementationPlan(plan);
    const isomorphicHash = hashIsomorphicPlan(plan);

    const prevPlanHash = task.implementationGate?.planHash || null;
    const prevIsoHash = task.implementationGate?.isomorphicHash || null;
    const isSamePlan =
      (!input.progressKey || task.implementationGate?.progressKey === input.progressKey) &&
      Boolean(
        (prevPlanHash && prevPlanHash === planHash) ||
        (prevIsoHash && prevIsoHash === isomorphicHash)
      );

    const maxRepeats = Number(input.maxPlanRepeats || process.env[ENV.MAX_IDENTICAL_PLANS] || 3);
    const currentRepeats = isSamePlan
      ? (Number(task.implementationGate?.consecutiveRepeats) || 1) + 1
      : 1;

    if (isSamePlan && currentRepeats > maxRepeats) {
      task.implementationGate = {
        ...(task.implementationGate || {}),
        planHash,
        isomorphicHash,
        sourceInvocationId: input.invocationId,
        progressKey: input.progressKey || null,
        consecutiveRepeats: currentRepeats,
        loopDetected: true,
        loopDetectedAt: new Date().toISOString(),
      };
      const saved = persist(task, {
        type: "implementation_plan_loop_detected",
        from: STATE.IMPLEMENT,
        to: STATE.IMPLEMENT,
        actorAgentId,
        intent: "plan",
        planHash,
        isomorphicHash,
        consecutiveRepeats: currentRepeats,
      });
      return {
        accepted: false,
        loopDetected: true,
        reason: "duplicate_plan_loop_detected",
        planHash,
        isomorphicHash,
        consecutiveRepeats: currentRepeats,
        task: saved,
      };
    }

    if (
      task.implementationGate?.planHash === planHash &&
      task.artifacts?.implementationPlan?.hash === planHash
    ) {
      task.implementationGate = {
        ...task.implementationGate,
        sourceInvocationId: input.invocationId,
        progressKey: input.progressKey || null,
        isomorphicHash,
        consecutiveRepeats: currentRepeats,
      };
      const saved = persist(task);
      return {
        accepted: true,
        reused: true,
        reason: null,
        planHash,
        isomorphicHash,
        consecutiveRepeats: currentRepeats,
        task: saved,
      };
    }
    task.phase = STATE.IMPLEMENT;
    task.state = STATE.IMPLEMENT;
    task.artifacts = {
      ...(task.artifacts || {}),
      implementationPlan: {
        ...plan,
        hash: planHash,
        isomorphicHash,
        proposedBy: actorAgentId,
        proposedAt: new Date().toISOString(),
      },
    };
    delete task.artifacts.progress;
    delete task.artifacts.codeReview;
    delete task.artifacts.delivery;
    delete task.artifacts.finalAcceptance;
    delete task.artifacts.acceptanceDecision;
    task.taskStatus = "active";
    task.implementationGate = {
      ...(task.implementationGate || {}),
      status: IMPLEMENTATION_GATE_STATUS.PENDING_APPROVAL,
      planHash,
      isomorphicHash,
      sourceInvocationId: input.invocationId,
      progressKey: input.progressKey || null,
      consecutiveRepeats: currentRepeats,
      loopDetected: false,
      approvedPlanHash: null,
      proposedBy: actorAgentId,
      proposedAt: new Date().toISOString(),
      approvedBy: null,
      approvedAt: null,
    };
    task.codeReviewGate = null;
    task.deliveryGate = null;
    task.finalGate = null;
    task.approvalHash = null;
    const saved = persist(task, {
      type: "implementation_plan_submitted",
      from: STATE.IMPLEMENT,
      to: STATE.IMPLEMENT,
      actorAgentId,
      intent: "plan",
      planHash,
      isomorphicHash,
      consecutiveRepeats: currentRepeats,
    });
    return {
      accepted: true,
      reason: null,
      planHash,
      isomorphicHash,
      consecutiveRepeats: currentRepeats,
      task: saved,
    };
  }

  function approveImplementationPlan(threadId, input = {}) {
    if (!threadId) return { approved: false, reason: "missing_thread" };
    const actorAgentId = String(input.actorAgentId || "").toLowerCase();
    if (!canApprovePlan(input.actorDuty)) {
      return { approved: false, reason: "plan_approval_requires_discuss_or_accept_duty" };
    }
    const task = getTask(threadId);
    const gate = task?.implementationGate;
    if (!gate?.planHash || gate.status !== IMPLEMENTATION_GATE_STATUS.PENDING_APPROVAL) {
      return { approved: false, reason: "implementation_plan_not_pending" };
    }
    const requestedHash = String(input.planHash || gate.planHash);
    if (requestedHash !== gate.planHash) {
      return { approved: false, reason: "implementation_plan_hash_mismatch" };
    }

    task.implementationGate = {
      ...gate,
      status: IMPLEMENTATION_GATE_STATUS.APPROVED,
      approvedPlanHash: gate.planHash,
      approvedBy: actorAgentId,
      approvedAt: new Date().toISOString(),
    };
    task.approvalHash = gate.planHash;
    const saved = persist(task, {
      type: "implementation_plan_approved",
      from: task.phase,
      to: task.phase,
      actorAgentId,
      intent: "implement",
      planHash: gate.planHash,
    });
    return { approved: true, reason: null, planHash: gate.planHash, task: saved };
  }

  function implementationPermission(threadId) {
    const task = getTask(threadId);
    const gate = task?.implementationGate || null;
    const artifactHash = String(task?.artifacts?.implementationPlan?.hash || "");
    const artifactBound = Boolean(gate?.planHash && artifactHash === String(gate.planHash));
    if (gate?.loopDetected) {
      return {
        allowed: false,
        reason: "duplicate_plan_loop_detected",
        status: gate.status || IMPLEMENTATION_GATE_STATUS.REQUIRED,
        planHash: gate.planHash || null,
        artifactBound,
        gate,
      };
    }
    if (isTaskImplementationApproved(task)) {
      return {
        allowed: true,
        reason: null,
        status: gate.status,
        planHash: gate.planHash,
        artifactBound: true,
        gate,
      };
    }
    return {
      allowed: false,
      reason: !gate?.planHash
        ? "implementation_plan_missing"
        : !artifactBound
          ? "implementation_plan_artifact_missing"
          : "implementation_plan_not_approved",
      status: gate?.status || IMPLEMENTATION_GATE_STATUS.REQUIRED,
      planHash: gate?.planHash || null,
      artifactBound,
      gate,
    };
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
      permission.status === IMPLEMENTATION_GATE_STATUS.PENDING_APPROVAL &&
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
    let next = previous;

    if (intent === "discuss") {
      next = STATE.DISCUSS;
    } else if (
      intent === "implement" ||
      intent === "fix" ||
      (intent === "plan" && isImplementationDuty(toDuty))
    ) {
      next = STATE.IMPLEMENT;
    } else if (intent === "plan") {
      next = STATE.DISCUSS;
    } else if (intent === "review") {
      next = STATE.REVIEW;
    } else if (intent === "deliver" || intent === "accept") {
      next = STATE.DELIVER;
    } else if (!intent && isReviewDuty(toDuty)) {
      next = STATE.REVIEW;
    } else if (!intent && (useWorktree || isImplementationDuty(toDuty))) {
      next = STATE.IMPLEMENT;
    }

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

  function updateTask(threadId, patch = {}, event = {}) {
    const task = getOrCreateTask(threadId);
    for (const key of [
      "goal",
      "contentHash",
      "artifacts",
      "implementationGate",
      "codeReviewGate",
      "deliveryGate",
      "finalGate",
    ]) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) task[key] = patch[key];
    }
    return persist(task, {
      type: event.type || "gate_update",
      from: task.phase,
      to: task.phase,
      actorAgentId: event.actorAgentId || null,
      intent: normalizeIntent(event.intent) || null,
      fields: Object.keys(patch),
    });
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

  function resetForTests() {
    tasksByThread.clear();
  }

  return {
    getTask,
    getOrCreateTask,
    captureUserGoal,
    submitTaskUpdate,
    submitSolutionBaseline,
    recordCodeReview,
    recordDeliveryEvidence,
    submitFinalAcceptance,
    acceptanceReadiness,
    shouldBlockEvidenceRoute,
    noteAcceptedRoute,
    ensureImplementationPlanRequired,
    submitImplementationPlan,
    approveImplementationPlan,
    implementationPermission,
    shouldBlockImplementationRoute,
    updateTask,
    shouldSkipRedundantReview,
    resetForTests,
  };
}

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

function resetOutcomeEvidence(task) {
  task.phase = STATE.DISCUSS;
  task.state = STATE.DISCUSS;
  task.goal = null;
  task.artifacts = {};
  task.implementationGate = null;
  task.codeReviewGate = null;
  task.deliveryGate = null;
  task.finalGate = null;
  task.approvalHash = null;
  task.taskStatus = "active";
}

function invalidateAfterSolutionRevision(task) {
  task.phase = STATE.DISCUSS;
  task.state = STATE.DISCUSS;
  task.artifacts = { ...(task.artifacts || {}) };
  delete task.artifacts.implementationPlan;
  delete task.artifacts.progress;
  delete task.artifacts.codeReview;
  delete task.artifacts.delivery;
  delete task.artifacts.finalAcceptance;
  delete task.artifacts.acceptanceDecision;
  task.implementationGate = null;
  task.codeReviewGate = null;
  task.deliveryGate = null;
  task.finalGate = null;
  task.approvalHash = null;
  task.taskStatus = "active";
}

function decorateCollabEvent(event) {
  if (event.actorKind) {
    return event.actorId ? event : { ...event, actorId: event.actorAgentId || "system" };
  }
  const actorAgentId = String(event.actorAgentId || "").toLowerCase();
  if (actorAgentId === "user") {
    return { ...event, actorKind: "human", actorId: event.actorId || "user" };
  }
  if (actorAgentId) {
    return { ...event, actorKind: "seat", actorId: event.actorId || actorAgentId };
  }
  return { ...event, actorKind: "system", actorId: event.actorId || "system" };
}

function invalidateDownstreamGates(task, previous, next, route = {}) {
  task.artifacts = { ...(task.artifacts || {}) };
  if (next === STATE.IMPLEMENT && previous !== STATE.IMPLEMENT) {
    const keepRequestedReview =
      task.codeReviewGate?.verdict === "changes_requested" &&
      (route.intent === "fix" || route.toDuty === "fix");
    if (!keepRequestedReview) {
      task.codeReviewGate = null;
      delete task.artifacts.codeReview;
    }
    task.deliveryGate = null;
    task.finalGate = null;
    delete task.artifacts.delivery;
    delete task.artifacts.finalAcceptance;
    delete task.artifacts.acceptanceDecision;
    task.taskStatus = "active";
    task.approvalHash = null;
  } else if (next === STATE.REVIEW && previous !== STATE.REVIEW) {
    task.deliveryGate = null;
    task.finalGate = null;
    delete task.artifacts.delivery;
    delete task.artifacts.finalAcceptance;
    delete task.artifacts.acceptanceDecision;
    task.taskStatus = "active";
  } else if (next === STATE.DELIVER && previous !== STATE.DELIVER) {
    task.finalGate = null;
    delete task.artifacts.finalAcceptance;
    delete task.artifacts.acceptanceDecision;
    task.taskStatus = "active";
  }
}

function normalizePhase(value) {
  const phase = String(value || STATE.DISCUSS)
    .trim()
    .toLowerCase();
  if (!COLLAB_TASK_STATES.includes(phase)) {
    throw new Error(`Unsupported collaboration phase: ${phase || "(missing)"}`);
  }
  return phase;
}

const defaultRegistry = createCollabTaskRegistry();

module.exports = {
  ...defaultRegistry,
  STATE,
  COLLAB_TASK_STATES,
  createCollabTaskRegistry,
  emptyTask,
  hashEvidence,
  isReviewDuty,
  isImplementationDuty,
  isDiscussDuty,
  isDeliverDuty,
  normalizePhase,
};

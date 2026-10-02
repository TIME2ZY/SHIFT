/**
 * Gate recording for the collaboration task registry.
 *
 * Six entry points record one piece of outcome evidence each — solution
 * baseline, code review, delivery, final acceptance, implementation plan,
 * plan approval. applyGateUpdate owns the shared spine (thread and task
 * guards, actor normalization, and exactly one persist call); each gate
 * supplies validate / detect / mutate, where detect may end the update early
 * and mutate may bail without persisting. Keeping the persist call in one
 * place is what keeps the invalidation cut points from drifting between
 * gates.
 */

"use strict";

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
const { COLLAB_TASK_PHASE: STATE } = require("../shared/collab-contracts");
const {
  isTaskImplementationApproved,
  isTaskSolutionBound,
  readAcceptanceReadiness,
} = require("./workflow-readiness");
const { clearDownstreamEvidence } = require("./task-evidence-reset");

function rejectAccepted(reason) {
  return { accepted: false, reason };
}

function rejectApproved(reason) {
  return { approved: false, reason };
}

/**
 * Run one gate update through the shared skeleton.
 *
 * @param {string} threadId collaboration thread
 * @param {object} spec gate definition (reject, loadTask, requireTask,
 *   validate, detect, mutate)
 * @param {object} input caller-supplied evidence
 * @returns {object} the gate's result, always carrying the task
 */
function applyGateUpdate(threadId, spec, input = {}) {
  if (!threadId) return spec.reject("missing_thread");
  const actorAgentId = String(input.actorAgentId || "").toLowerCase();
  // Guards that must fire before the task is loaded, so an unbound evidence
  // event leaves no collaboration state behind.
  if (spec.requireInvocationId) {
    if (typeof input.invocationId !== "string" || !input.invocationId.trim()) {
      return spec.reject("missing_invocation");
    }
  }
  const task = spec.loadTask(threadId);
  if (!task && spec.requireTask) return spec.reject("collaboration_task_missing");
  const step = { threadId, input, actorAgentId, task };
  const rejection = spec.validate(step);
  if (rejection) return rejection;
  const early = spec.detect ? spec.detect(step) : null;
  if (early) return early;
  const outcome = spec.mutate(step);
  if (outcome.early) return outcome.early;
  const saved = spec.persist(task, outcome.event);
  return { ...outcome.result, task: saved };
}

/**
 * @param {object} core registry core (reads: getTask, getOrCreateTask, persist,
 *   options, hashEvidence, isReviewDuty, isImplementationDuty, isDeliverDuty,
 *   isAcceptanceDuty, canApprovePlan)
 * @param {object} deps sibling modules (reads: invalidateAfterSolutionRevision)
 * @returns {{ submitSolutionBaseline, recordCodeReview, recordDeliveryEvidence,
 *   submitFinalAcceptance, submitImplementationPlan, approveImplementationPlan,
 *   requireImplementationPlan, ensureImplementationPlanRequired }}
 */
function createGateRecorder(core, deps) {
  const {
    getTask,
    getOrCreateTask,
    persist,
    hashEvidence,
    isReviewDuty,
    isImplementationDuty,
    isDeliverDuty,
    isAcceptanceDuty,
    canApprovePlan,
  } = core;
  const { invalidateAfterSolutionRevision } = deps;

  /** Bind one gate spec to this registry's persist call. */
  const runGate = (threadId, spec, input) => applyGateUpdate(threadId, { ...spec, persist }, input);

  /**
   * Require an implementation plan on a task, clearing whatever a fresh plan
   * would replace. Returns whether it changed anything; does not persist.
   */
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
    clearDownstreamEvidence(task);
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

  const submitSolutionBaseline = (threadId, input = {}) =>
    runGate(
      threadId,
      {
        reject: rejectAccepted,
        loadTask: getOrCreateTask,
        requireTask: false,
        validate(step) {
          if (
            !["discuss", "plan", "accept"].includes(
              String(step.input.actorDuty || "").toLowerCase()
            )
          ) {
            return rejectAccepted("solution_requires_discuss_plan_or_accept_duty");
          }
          const baseline = step.input.baseline || parseSolutionBaseline(step.input.content);
          if (!baseline) return rejectAccepted("invalid_or_missing_solution_baseline");
          const goalHash = String(step.task.artifacts?.userGoal?.hash || "");
          if (!goalHash) return rejectAccepted("user_goal_missing");
          if (String(baseline.user_goal_hash || "") !== goalHash) {
            return rejectAccepted("solution_user_goal_mismatch");
          }
          if (step.task.submittedAt) {
            const expected = [...step.task.contract.acceptanceCriteria]
              .map((value) => value.trim())
              .sort();
            const actual = [...baseline.acceptance_criteria].map((value) => value.trim()).sort();
            if (JSON.stringify(expected) !== JSON.stringify(actual))
              return rejectAccepted("frozen_acceptance_criteria_mismatch");
          }
          step.baseline = baseline;
          step.goalHash = goalHash;
          step.solutionHash = hashSolutionBaseline(baseline);
          return null;
        },
        detect(step) {
          if (step.task.artifacts?.solutionBaseline?.hash === step.solutionHash) {
            return {
              accepted: true,
              reused: true,
              solutionHash: step.solutionHash,
              task: step.task,
            };
          }
          return null;
        },
        mutate(step) {
          const previousHash = step.task.artifacts?.solutionBaseline?.hash || null;
          if (previousHash && previousHash !== step.solutionHash) {
            invalidateAfterSolutionRevision(step.task);
          }
          step.task.artifacts = {
            ...(step.task.artifacts || {}),
            solutionBaseline: {
              ...step.baseline,
              hash: step.solutionHash,
              submittedBy: step.actorAgentId,
              submittedAt: new Date().toISOString(),
            },
          };
          return {
            event: {
              type: "solution_baseline_submitted",
              from: step.task.phase,
              to: step.task.phase,
              actorAgentId: step.actorAgentId,
              intent: "plan",
              goalHash: step.goalHash,
              solutionHash: step.solutionHash,
            },
            result: { accepted: true, reused: false, solutionHash: step.solutionHash },
          };
        },
      },
      input
    );

  const recordCodeReview = (threadId, input = {}) =>
    runGate(
      threadId,
      {
        reject: rejectAccepted,
        loadTask: getTask,
        requireTask: true,
        requireInvocationId: true,
        validate(step) {
          const actorDuty = String(step.input.actorDuty || "").toLowerCase();
          if (!isReviewDuty(actorDuty) && !isDeliverDuty(actorDuty)) {
            return rejectAccepted("review_requires_review_or_deliver_duty");
          }
          const review = step.input.review || parseCodeReview(step.input.content);
          if (!review) return rejectAccepted("invalid_or_missing_code_review");
          step.actorDuty = actorDuty;
          step.review = review;
          return null;
        },
        detect(step) {
          const { task, input, actorAgentId } = step;
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
          const reviewEvidenceHash = hashCodeReview(step.review);
          const maxRepeats = Number(
            input.maxReviewRepeats || process.env[ENV.MAX_IDENTICAL_PLANS] || 3
          );
          const isSameReview = Boolean(
            task.codeReviewGate?.evidenceHash === reviewEvidenceHash &&
            task.codeReviewGate?.verdict === step.review.verdict &&
            (!input.progressKey || task.codeReviewGate?.progressKey === input.progressKey)
          );
          const consecutiveRepeats = isSameReview
            ? (Number(task.codeReviewGate?.consecutiveRepeats) || 1) + 1
            : 1;
          step.reviewEvidenceHash = reviewEvidenceHash;
          step.consecutiveRepeats = consecutiveRepeats;

          if (isSameReview && consecutiveRepeats > maxRepeats) {
            task.codeReviewGate = {
              ...(task.codeReviewGate || {}),
              evidenceHash: reviewEvidenceHash,
              verdict: step.review.verdict,
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
              verdict: step.review.verdict,
              consecutiveRepeats,
            });
            return {
              accepted: false,
              loopDetected: true,
              reason: "duplicate_review_loop_detected",
              verdict: step.review.verdict,
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
              verdict: step.review.verdict,
              reviewEvidenceHash,
              consecutiveRepeats,
              task: saved,
            };
          }
          return null;
        },
        mutate(step) {
          const { task, input, actorAgentId } = step;
          const reviewedAt = new Date().toISOString();
          task.artifacts = {
            ...(task.artifacts || {}),
            codeReview: {
              ...step.review,
              hash: step.reviewEvidenceHash,
              reviewedBy: actorAgentId,
              reviewedAt,
            },
          };
          if (step.review.verdict === "changes_requested") {
            clearDownstreamEvidence(task, { from: 3 });
            task.deliveryGate = null;
            task.finalGate = null;
            task.approvalHash = null;
          }
          task.taskStatus = "active";
          task.codeReviewGate = {
            verdict: step.review.verdict,
            evidenceHash: step.reviewEvidenceHash,
            sourceInvocationId: input.invocationId,
            progressKey: input.progressKey || null,
            consecutiveRepeats: 1,
            loopDetected: false,
            reviewedBy: actorAgentId,
            reviewedAt,
          };
          return {
            event: {
              type:
                step.review.verdict === "approve"
                  ? "code_review_approved"
                  : "code_review_changes_requested",
              from: task.phase,
              to: task.phase,
              actorAgentId,
              actorId: input.fromSeatId || actorAgentId,
              duty: step.actorDuty,
              intent: "review",
              verdict: step.review.verdict,
              reviewEvidenceHash: step.reviewEvidenceHash,
              consecutiveRepeats: 1,
            },
            result: {
              accepted: true,
              reused: false,
              verdict: step.review.verdict,
              reviewEvidenceHash: step.reviewEvidenceHash,
              consecutiveRepeats: 1,
            },
          };
        },
      },
      input
    );

  const recordDeliveryEvidence = (threadId, input = {}) =>
    runGate(
      threadId,
      {
        reject: rejectAccepted,
        loadTask: getTask,
        requireTask: true,
        validate(step) {
          const actorDuty = String(step.input.actorDuty || "").toLowerCase();
          if (!isReviewDuty(actorDuty) && !isDeliverDuty(actorDuty)) {
            return rejectAccepted("delivery_requires_review_or_deliver_duty");
          }
          const review = step.input.review || parseCodeReview(step.input.content);
          if (!review) return rejectAccepted("invalid_or_missing_code_review");
          if (review.verdict !== "approve") return rejectAccepted("code_review_not_approved");
          const receipt = step.input.receipt || parseDeliveryReceipt(step.input.content);
          if (!receipt) return rejectAccepted("invalid_or_missing_delivery_receipt");
          const verification = step.input.verification || null;
          const verified = validateVerifiedDelivery(verification, receipt);
          if (!verified.ok) return rejectAccepted(verified.reason);
          if (!isTaskImplementationApproved(step.task)) {
            return rejectAccepted("implementation_plan_not_approved");
          }
          if (!isTaskSolutionBound(step.task)) return rejectAccepted("solution_baseline_missing");
          step.review = review;
          step.receipt = receipt;
          step.verification = verification;
          return null;
        },
        detect(step) {
          const reviewEvidenceHash = hashCodeReview(step.review, step.verification.commitSha);
          step.reviewEvidenceHash = reviewEvidenceHash;
          const { task, verification } = step;
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
          return null;
        },
        mutate(step) {
          const { task, input, actorAgentId } = step;
          const reviewedAt = new Date().toISOString();
          task.artifacts = {
            ...(task.artifacts || {}),
            codeReview: {
              ...step.review,
              hash: step.reviewEvidenceHash,
              commitSha: step.verification.commitSha,
              reviewedBy: actorAgentId,
              reviewedAt,
            },
            delivery: {
              ...step.receipt,
              ...step.verification,
              reviewEvidenceHash: step.reviewEvidenceHash,
            },
          };
          clearDownstreamEvidence(task, { from: 4 });
          task.taskStatus = "active";
          task.codeReviewGate = {
            ...task.codeReviewGate,
            sourceInvocationId:
              input.invocationId || task.codeReviewGate?.sourceInvocationId || null,
            verdict: "approve",
            evidenceHash: step.reviewEvidenceHash,
            commitSha: step.verification.commitSha,
            reviewedBy: actorAgentId,
            reviewedAt,
          };
          task.deliveryGate = {
            reviewEvidenceHash: step.reviewEvidenceHash,
            commitSha: step.verification.commitSha,
            branch: step.verification.branch,
            baseBranch: step.verification.baseBranch,
            prUrl: step.verification.prUrl,
            prNumber: step.verification.prNumber,
            ciStatus: step.verification.ciStatus,
            verifiedBy: actorAgentId,
            verifiedAt: step.verification.verifiedAt || new Date().toISOString(),
          };
          task.finalGate = null;
          task.approvalHash = step.reviewEvidenceHash;
          const previous = task.phase;
          task.phase = STATE.DELIVER;
          task.state = STATE.DELIVER;
          return {
            event: {
              type: "delivery_evidence_verified",
              from: previous,
              to: STATE.DELIVER,
              actorAgentId,
              intent: "deliver",
              reviewEvidenceHash: step.reviewEvidenceHash,
              commitSha: step.verification.commitSha,
              prUrl: step.verification.prUrl,
              ciStatus: step.verification.ciStatus,
            },
            result: {
              accepted: true,
              readyForAcceptance: step.verification.ciStatus === "success",
              reason: step.verification.ciStatus === "success" ? null : "ci_not_successful",
              reviewEvidenceHash: step.reviewEvidenceHash,
            },
          };
        },
      },
      input
    );

  const submitFinalAcceptance = (threadId, input = {}) =>
    runGate(
      threadId,
      {
        reject: rejectAccepted,
        loadTask: getTask,
        requireTask: true,
        validate(step) {
          if (!isAcceptanceDuty(step.input.actorDuty)) {
            return rejectAccepted("final_acceptance_requires_accept_duty");
          }
          const acceptance = step.input.acceptance || parseFinalAcceptance(step.input.content);
          if (!acceptance) return rejectAccepted("invalid_or_missing_final_acceptance");
          if (!isTaskSolutionBound(step.task)) return rejectAccepted("solution_baseline_missing");
          const validation = validateFinalAcceptanceAgainstTask(acceptance, step.task);
          if (!validation.ok) return rejectAccepted(validation.reason);
          step.acceptance = acceptance;
          step.acceptanceHash = hashEvidence({
            goal: acceptance.user_goal_hash,
            what: JSON.stringify(acceptance.checks),
            diffHash: acceptance.commit_sha,
            testHash: acceptance.solution_hash,
          });
          return null;
        },
        detect() {
          return null;
        },
        mutate(step) {
          const { task, actorAgentId } = step;
          const requestedVerdict =
            String(step.acceptance.verdict || "").toLowerCase() === "reject"
              ? "rejected"
              : "accepted";
          task.artifacts = {
            ...(task.artifacts || {}),
            finalAcceptance: {
              ...step.acceptance,
              hash: step.acceptanceHash,
              acceptedBy: actorAgentId,
              acceptedAt: new Date().toISOString(),
            },
          };
          if (task.phase === STATE.DONE && requestedVerdict !== "accepted") {
            task.phase = STATE.DELIVER;
            task.state = STATE.DELIVER;
          }
          task.finalGate = {
            verdict: step.acceptance.verdict,
            evidenceHash: step.acceptanceHash,
            userGoalHash: step.acceptance.user_goal_hash,
            solutionHash: step.acceptance.solution_hash,
            implementationPlanHash: step.acceptance.implementation_plan_hash,
            acceptedCommitSha: step.acceptance.commit_sha,
            acceptedBy: actorAgentId,
            acceptedAt: new Date().toISOString(),
          };
          const readiness =
            requestedVerdict === "accepted"
              ? readAcceptanceReadiness(task, core.options.readWorkspace)
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
              early: {
                accepted: true,
                reused: true,
                recorded: true,
                readiness,
                verdict,
                reason,
                acceptanceHash: step.acceptanceHash,
                taskStatus: task.taskStatus,
                task,
              },
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
          return {
            event: {
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
              acceptanceHash: step.acceptanceHash,
              goalHash,
              planHash,
              commitSha,
            },
            result: {
              accepted: true,
              reused: false,
              recorded: true,
              readiness,
              verdict,
              reason,
              acceptanceHash: step.acceptanceHash,
              taskStatus: task.taskStatus,
            },
          };
        },
      },
      input
    );

  const submitImplementationPlan = (threadId, input = {}) =>
    runGate(
      threadId,
      {
        reject: rejectAccepted,
        loadTask: getOrCreateTask,
        requireTask: false,
        requireInvocationId: true,
        validate(step) {
          if (!isImplementationDuty(step.input.actorDuty)) {
            return rejectAccepted("plan_requires_plan_implement_or_fix_duty");
          }
          const plan = step.input.plan || parseImplementationPlan(step.input.content);
          if (!plan || !validateImplementationPlan(plan).ok) {
            return rejectAccepted("invalid_or_missing_implementation_plan");
          }
          step.plan = plan;
          step.planHash = hashImplementationPlan(plan);
          step.isomorphicHash = hashIsomorphicPlan(plan);
          return null;
        },
        detect(step) {
          const { task, input, actorAgentId } = step;
          // A first submission must open the gate before its own dedup check.
          if (!task.implementationGate) {
            requireImplementationPlan(task, { requestedBy: actorAgentId });
          }
          if (task.implementationGate?.sourceInvocationId === input.invocationId) {
            return {
              accepted: !task.implementationGate.loopDetected,
              loopDetected: Boolean(task.implementationGate.loopDetected),
              reused: true,
              planHash: task.implementationGate.planHash,
              task,
            };
          }
          const prevPlanHash = task.implementationGate?.planHash || null;
          const prevIsoHash = task.implementationGate?.isomorphicHash || null;
          const isSamePlan =
            (!input.progressKey || task.implementationGate?.progressKey === input.progressKey) &&
            Boolean(
              (prevPlanHash && prevPlanHash === step.planHash) ||
              (prevIsoHash && prevIsoHash === step.isomorphicHash)
            );
          const maxRepeats = Number(
            input.maxPlanRepeats || process.env[ENV.MAX_IDENTICAL_PLANS] || 3
          );
          const currentRepeats = isSamePlan
            ? (Number(task.implementationGate?.consecutiveRepeats) || 1) + 1
            : 1;
          step.consecutiveRepeats = currentRepeats;

          if (isSamePlan && currentRepeats > maxRepeats) {
            task.implementationGate = {
              ...(task.implementationGate || {}),
              planHash: step.planHash,
              isomorphicHash: step.isomorphicHash,
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
              planHash: step.planHash,
              isomorphicHash: step.isomorphicHash,
              consecutiveRepeats: currentRepeats,
            });
            return {
              accepted: false,
              loopDetected: true,
              reason: "duplicate_plan_loop_detected",
              planHash: step.planHash,
              isomorphicHash: step.isomorphicHash,
              consecutiveRepeats: currentRepeats,
              task: saved,
            };
          }

          if (
            task.implementationGate?.planHash === step.planHash &&
            task.artifacts?.implementationPlan?.hash === step.planHash
          ) {
            task.implementationGate = {
              ...task.implementationGate,
              sourceInvocationId: input.invocationId,
              progressKey: input.progressKey || null,
              isomorphicHash: step.isomorphicHash,
              consecutiveRepeats: currentRepeats,
            };
            const saved = persist(task);
            return {
              accepted: true,
              reused: true,
              reason: null,
              planHash: step.planHash,
              isomorphicHash: step.isomorphicHash,
              consecutiveRepeats: currentRepeats,
              task: saved,
            };
          }
          return null;
        },
        mutate(step) {
          const { task, input, actorAgentId } = step;
          task.phase = STATE.IMPLEMENT;
          task.state = STATE.IMPLEMENT;
          task.artifacts = {
            ...(task.artifacts || {}),
            implementationPlan: {
              ...step.plan,
              hash: step.planHash,
              isomorphicHash: step.isomorphicHash,
              proposedBy: actorAgentId,
              proposedAt: new Date().toISOString(),
            },
          };
          clearDownstreamEvidence(task, { from: 1 });
          task.taskStatus = "active";
          task.implementationGate = {
            ...(task.implementationGate || {}),
            status: IMPLEMENTATION_GATE_STATUS.PENDING_APPROVAL,
            planHash: step.planHash,
            isomorphicHash: step.isomorphicHash,
            sourceInvocationId: input.invocationId,
            progressKey: input.progressKey || null,
            consecutiveRepeats: step.consecutiveRepeats,
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
          return {
            event: {
              type: "implementation_plan_submitted",
              from: STATE.IMPLEMENT,
              to: STATE.IMPLEMENT,
              actorAgentId,
              intent: "plan",
              planHash: step.planHash,
              isomorphicHash: step.isomorphicHash,
              consecutiveRepeats: step.consecutiveRepeats,
            },
            result: {
              accepted: true,
              reason: null,
              planHash: step.planHash,
              isomorphicHash: step.isomorphicHash,
              consecutiveRepeats: step.consecutiveRepeats,
            },
          };
        },
      },
      input
    );

  const approveImplementationPlan = (threadId, input = {}) =>
    runGate(
      threadId,
      {
        reject: rejectApproved,
        loadTask: getTask,
        requireTask: false,
        validate(step) {
          if (!canApprovePlan(step.input.actorDuty)) {
            return rejectApproved("plan_approval_requires_discuss_or_accept_duty");
          }
          const gate = step.task?.implementationGate;
          if (!gate?.planHash || gate.status !== IMPLEMENTATION_GATE_STATUS.PENDING_APPROVAL) {
            return rejectApproved("implementation_plan_not_pending");
          }
          const requestedHash = String(step.input.planHash || gate.planHash);
          if (requestedHash !== gate.planHash) {
            return rejectApproved("implementation_plan_hash_mismatch");
          }
          step.gate = gate;
          return null;
        },
        detect() {
          return null;
        },
        mutate(step) {
          const { task, actorAgentId } = step;
          task.implementationGate = {
            ...step.gate,
            status: IMPLEMENTATION_GATE_STATUS.APPROVED,
            approvedPlanHash: step.gate.planHash,
            approvedBy: actorAgentId,
            approvedAt: new Date().toISOString(),
          };
          task.approvalHash = step.gate.planHash;
          return {
            event: {
              type: "implementation_plan_approved",
              from: task.phase,
              to: task.phase,
              actorAgentId,
              intent: "implement",
              planHash: step.gate.planHash,
            },
            result: { approved: true, reason: null, planHash: step.gate.planHash },
          };
        },
      },
      input
    );

  return {
    submitSolutionBaseline,
    recordCodeReview,
    recordDeliveryEvidence,
    submitFinalAcceptance,
    submitImplementationPlan,
    approveImplementationPlan,
    requireImplementationPlan,
    ensureImplementationPlanRequired,
  };
}

module.exports = { createGateRecorder, applyGateUpdate };

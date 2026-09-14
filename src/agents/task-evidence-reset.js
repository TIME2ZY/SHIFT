/**
 * Outcome-evidence invalidation for the collaboration task registry (Phase C-8
 * extract from collab-task-registry).
 *
 * Downstream evidence accumulates along a fixed lifecycle — goal, solution
 * baseline, implementation plan, progress, code review, delivery, final
 * acceptance, acceptance decision — and every gate transition must drop a
 * specific suffix of that chain. Those suffixes were spelled out as
 * thirty-one `delete task.artifacts.X` lines across six non-adjacent sites
 * (require-plan, submit-plan, code review, delivery, solution revision, and
 * the phase-transition invalidator), each with a slightly different cut
 * point, so a new gate could easily clear too much or too little.
 *
 * clearDownstreamEvidence(task, { from, keep }) states the cut point once:
 * from is the index into DOWNSTREAM_ARTIFACTS where deletion starts, keep is
 * the set of names a transition must preserve. Every site's deletion set is
 * preserved verbatim — only the spelling changed.
 */

"use strict";

const { COLLAB_TASK_PHASE: STATE } = require("../shared/collab-contracts");

/** Evidence lifecycle order; clearing starts at `from` and runs to the end. */
const DOWNSTREAM_ARTIFACTS = Object.freeze([
  "implementationPlan",
  "progress",
  "codeReview",
  "delivery",
  "finalAcceptance",
  "acceptanceDecision",
]);

/**
 * Delete the downstream evidence suffix of one task.
 *
 * @param {object} task collaboration task (mutated in place)
 * @param {object} [opts]
 * @param {number} [opts.from=0] index into DOWNSTREAM_ARTIFACTS to start at
 * @param {Set<string>|string[]} [opts.keep] artifact names to preserve
 * @returns {void}
 */
function clearDownstreamEvidence(task, { from = 0, keep } = {}) {
  if (!task) return;
  const keepSet = keep instanceof Set ? keep : new Set(keep || []);
  task.artifacts = { ...(task.artifacts || {}) };
  for (let i = from; i < DOWNSTREAM_ARTIFACTS.length; i += 1) {
    const name = DOWNSTREAM_ARTIFACTS[i];
    if (!keepSet.has(name)) delete task.artifacts[name];
  }
}

/** Full reset to the discuss phase, used when the task goal itself changes. */
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

/** A revised solution baseline invalidates everything downstream of the goal. */
function invalidateAfterSolutionRevision(task) {
  task.phase = STATE.DISCUSS;
  task.state = STATE.DISCUSS;
  clearDownstreamEvidence(task);
  task.implementationGate = null;
  task.codeReviewGate = null;
  task.deliveryGate = null;
  task.finalGate = null;
  task.approvalHash = null;
  task.taskStatus = "active";
}

/**
 * Drop the evidence a phase transition makes stale. Entering a phase removes
 * everything that phase would have to redo; the fix path keeps a
 * changes-requested review because that is exactly the feedback being acted on.
 *
 * @param {object} task collaboration task (mutated in place)
 * @param {string} previous phase before the transition
 * @param {string} next phase after the transition
 * @param {{ intent?: string, toDuty?: string }} [route]
 * @returns {void}
 */
function invalidateDownstreamGates(task, previous, next, route = {}) {
  if (next === STATE.IMPLEMENT && previous !== STATE.IMPLEMENT) {
    const keepRequestedReview =
      task.codeReviewGate?.verdict === "changes_requested" &&
      (route.intent === "fix" || route.toDuty === "fix");
    clearDownstreamEvidence(task, {
      from: 2,
      keep: keepRequestedReview ? ["codeReview"] : [],
    });
    if (!keepRequestedReview) task.codeReviewGate = null;
    task.deliveryGate = null;
    task.finalGate = null;
    task.taskStatus = "active";
    task.approvalHash = null;
  } else if (next === STATE.REVIEW && previous !== STATE.REVIEW) {
    clearDownstreamEvidence(task, { from: 3 });
    task.deliveryGate = null;
    task.finalGate = null;
    task.taskStatus = "active";
  } else if (next === STATE.DELIVER && previous !== STATE.DELIVER) {
    clearDownstreamEvidence(task, { from: 4 });
    task.finalGate = null;
    task.taskStatus = "active";
  }
}

module.exports = {
  DOWNSTREAM_ARTIFACTS,
  clearDownstreamEvidence,
  resetOutcomeEvidence,
  invalidateAfterSolutionRevision,
  invalidateDownstreamGates,
};

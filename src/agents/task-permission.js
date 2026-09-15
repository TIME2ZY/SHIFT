/**
 * Read-only permission queries for the collaboration task registry.
 *
 * Two questions asked of a task without mutating it: may this agent implement
 * now, and is acceptance ready. They are separate from the gate writers so a
 * routing decision can answer them without persisting.
 */

"use strict";

const { IMPLEMENTATION_GATE_STATUS } = require("./workflow-gates");
const { isTaskImplementationApproved } = require("./workflow-readiness");
const { readAcceptanceReadiness } = require("./workflow-readiness");

/**
 * @param {object} core registry core (reads: getTask, options)
 * @returns {{ implementationPermission, acceptanceReadiness }}
 */
function createPermissionQueries(core) {
  const { getTask, options } = core;

  /**
   * Whether the implementation gate currently permits implementation work.
   * @param {string} threadId
   * @returns {{ allowed: boolean, reason: string|null, status: string,
   *   planHash: string|null, artifactBound: boolean, gate: object|null }}
   */
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

  function acceptanceReadiness(threadId) {
    const task = getTask(threadId);
    if (!task) return { ok: false, reason: "collaboration_task_missing" };
    return readAcceptanceReadiness(task, options.readWorkspace);
  }

  return { implementationPermission, acceptanceReadiness };
}

module.exports = { createPermissionQueries };

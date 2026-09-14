/**
 * Collaboration task registry (Phase C-8 facade).
 *
 * The four concerns that used to live inside createCollabTaskRegistry — gate
 * recording, route policy, permission queries, and evidence invalidation — are
 * now sibling modules under src/agents/. This file keeps the task store (the
 * only piece every one of them needs wired the same way, whether in-memory or
 * SQLite-backed) plus the shared task primitives, and composes them into the
 * registry callers already hold.
 *
 * The exported shape is unchanged: createCollabTaskRegistry returns the same
 * method set, and the module still re-exports the primitives.
 */

"use strict";

const crypto = require("node:crypto");
const { createTaskUpdates } = require("./task-updates");
const { normalizeIntent } = require("./handoff");
const { COLLAB_TASK_STATES, COLLAB_TASK_PHASE: STATE } = require("../shared/collab-contracts");
const { createGateRecorder } = require("./task-gate-recorder");
const { createPermissionQueries } = require("./task-permission");
const { createRoutePolicy } = require("./task-route-policy");
const {
  resetOutcomeEvidence,
  invalidateAfterSolutionRevision,
  invalidateDownstreamGates,
} = require("./task-evidence-reset");

function isReviewDuty(duty) {
  return String(duty || "").toLowerCase() === "review";
}

function isImplementationDuty(duty) {
  return ["plan", "implement", "fix"].includes(String(duty || "").toLowerCase());
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

function normalizePhase(value) {
  const phase = String(value || STATE.DISCUSS)
    .trim()
    .toLowerCase();
  if (!COLLAB_TASK_STATES.includes(phase)) {
    throw new Error(`Unsupported collaboration phase: ${phase || "(missing)"}`);
  }
  return phase;
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

  // Shared wiring for the extracted concerns: the task store, the persistence
  // entry, and the pure task primitives they all read through.
  const core = {
    getTask,
    getOrCreateTask,
    persist,
    options,
    hashEvidence,
    isReviewDuty,
    isImplementationDuty,
    isDeliverDuty,
    isAcceptanceDuty,
    canApprovePlan,
  };

  const permissions = createPermissionQueries(core);
  const gates = createGateRecorder(core, { invalidateAfterSolutionRevision });
  const routes = createRoutePolicy(core, {
    requireImplementationPlan: gates.requireImplementationPlan,
    implementationPermission: permissions.implementationPermission,
    invalidateDownstreamGates,
  });
  const { captureUserGoal, submitTaskUpdate } = createTaskUpdates({
    getOrCreateTask,
    persist,
    resetOutcomeEvidence,
  });

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

  function resetForTests() {
    tasksByThread.clear();
  }

  return {
    getTask,
    getOrCreateTask,
    captureUserGoal,
    submitTaskUpdate,
    submitSolutionBaseline: gates.submitSolutionBaseline,
    recordCodeReview: gates.recordCodeReview,
    recordDeliveryEvidence: gates.recordDeliveryEvidence,
    submitFinalAcceptance: gates.submitFinalAcceptance,
    acceptanceReadiness: permissions.acceptanceReadiness,
    shouldBlockEvidenceRoute: routes.shouldBlockEvidenceRoute,
    noteAcceptedRoute: routes.noteAcceptedRoute,
    ensureImplementationPlanRequired: gates.ensureImplementationPlanRequired,
    submitImplementationPlan: gates.submitImplementationPlan,
    approveImplementationPlan: gates.approveImplementationPlan,
    implementationPermission: permissions.implementationPermission,
    shouldBlockImplementationRoute: routes.shouldBlockImplementationRoute,
    updateTask,
    shouldSkipRedundantReview: routes.shouldSkipRedundantReview,
    resetForTests,
  };
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
  isDeliverDuty,
  normalizePhase,
};

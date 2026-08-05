/**
 * Collaboration workflow registry.
 *
 * The default export remains an in-memory singleton for isolated callers and
 * tests. Server requests create a registry backed by SQLite so phase/gate
 * decisions survive process restarts.
 */

"use strict";

const crypto = require("node:crypto");
const { COLLAB_TASK_STATES } = require("../shared/collab-contracts");
const {
  REVIEWER_AGENT_IDS,
  IMPLEMENTER_AGENT_IDS,
  DISCUSSION_AGENT_IDS,
  DELIVERY_AGENT_IDS,
  normalizeIntent,
} = require("./handoff");

const STATE = Object.freeze({
  DISCUSS: "discuss",
  IMPLEMENT: "implement",
  REVIEW: "review",
  DELIVER: "deliver",
  DONE: "done",
});

function isReviewer(agentId) {
  return REVIEWER_AGENT_IDS.has(String(agentId || "").toLowerCase());
}

function isImplementer(agentId) {
  return IMPLEMENTER_AGENT_IDS.has(String(agentId || "").toLowerCase());
}

function isDiscussionAgent(agentId) {
  return DISCUSSION_AGENT_IDS.has(String(agentId || "").toLowerCase());
}

function isDeliveryAgent(agentId) {
  return DELIVERY_AGENT_IDS.has(String(agentId || "").toLowerCase());
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
    if (repository) return repository.save(task, event);

    if (event) {
      task.history = Array.isArray(task.history) ? task.history : [];
      task.history.push({ ...event, at: event.at || new Date().toISOString() });
      if (task.history.length > 40) task.history.shift();
    }
    task.version = Number(task.version || 0) + 1;
    tasksByThread.set(task.threadId, task);
    return { ...task, history: task.history.slice() };
  }

  /** Infer and persist the phase transition caused by one accepted A2A route. */
  function noteAcceptedRoute(input = {}) {
    const threadId = input.threadId;
    if (!threadId) return null;
    const task = getOrCreateTask(threadId);
    const from = String(input.fromAgent || "").toLowerCase();
    const to = String(input.toAgent || "").toLowerCase();
    const intent = normalizeIntent(input.intent) || "";
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
    if (handoff.goal) task.goal = handoff.goal;

    const previous = task.phase;
    let next = previous;

    if (intent === "discuss") {
      next = STATE.DISCUSS;
    } else if (["plan", "implement", "fix"].includes(intent)) {
      next = STATE.IMPLEMENT;
    } else if (intent === "review") {
      next = STATE.REVIEW;
    } else if (intent === "deliver" || intent === "accept") {
      next = STATE.DELIVER;
    } else if (!intent && isReviewer(to)) {
      next = STATE.REVIEW;
    } else if (!intent && (useWorktree || isImplementer(to))) {
      next = STATE.IMPLEMENT;
    }

    const reviewBlob = [handoff.what, handoff.next_action, handoff.goal, input.text]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    if (isReviewer(from)) {
      if (/request-changes|request_changes|请修|需修改|\bp0\b/.test(reviewBlob)) {
        next = STATE.IMPLEMENT;
        task.codeReviewGate = null;
        task.approvalHash = null;
      } else if (/approve-with-nits|approve\b|批准|可交付|可合入|lgtm/.test(reviewBlob)) {
        next = STATE.DELIVER;
        task.approvalHash = evidenceHash;
        task.codeReviewGate = {
          verdict: "approve",
          evidenceHash,
          reviewedBy: from,
          reviewedAt: new Date().toISOString(),
        };
      }
    }

    invalidateDownstreamGates(task, previous, next);
    task.phase = next;
    task.state = next;

    const event = {
      type: next === previous ? "route" : "transition",
      from: previous,
      to: next,
      actorAgentId: from || null,
      intent: intent || null,
      contentHash,
      targetAgentId: to || null,
      evidenceHash,
    };
    return persist(task, event);
  }

  function markDone(threadId, input = {}) {
    const task = getOrCreateTask(threadId);
    if (task.phase !== STATE.DELIVER) return task;
    const readiness = completionReadiness(task);
    if (!readiness.ok) return { ...task, completionBlocked: readiness.reason };
    const previous = task.phase;
    task.phase = STATE.DONE;
    task.state = STATE.DONE;
    return persist(task, {
      type: "transition",
      from: previous,
      to: STATE.DONE,
      actorAgentId: input.actorAgentId || null,
      intent: input.intent || "accept",
    });
  }

  /** Backward-compatible name; completion now means the terminal done phase. */
  function markDelivered(threadId, input = {}) {
    return markDone(threadId, input);
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
    const to = String(input.toAgent || "").toLowerCase();
    const intent = normalizeIntent(input.intent) || "";
    if (!isReviewer(to) && intent !== "review") return { skip: false };

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
    noteAcceptedRoute,
    updateTask,
    markDone,
    markDelivered,
    shouldSkipRedundantReview,
    resetForTests,
  };
}

function completionReadiness(task) {
  if (task?.codeReviewGate?.verdict !== "approve") {
    return { ok: false, reason: "code_review_not_approved" };
  }
  const reviewEvidenceHash = String(task.codeReviewGate.evidenceHash || "");
  if (
    !reviewEvidenceHash ||
    String(task?.deliveryGate?.reviewEvidenceHash || "") !== reviewEvidenceHash
  ) {
    return { ok: false, reason: "delivery_not_bound_to_review" };
  }
  const commitSha = String(task?.deliveryGate?.commitSha || "");
  if (!commitSha) return { ok: false, reason: "delivery_commit_missing" };
  if (task?.deliveryGate?.ciStatus !== "success") {
    return { ok: false, reason: "ci_not_successful" };
  }
  if (
    task?.finalGate?.verdict !== "accept" ||
    String(task.finalGate.acceptedCommitSha || "") !== commitSha
  ) {
    return { ok: false, reason: "final_acceptance_not_bound_to_commit" };
  }
  return { ok: true, reason: null };
}

function invalidateDownstreamGates(task, previous, next) {
  if (next === STATE.IMPLEMENT && previous !== STATE.IMPLEMENT) {
    task.codeReviewGate = null;
    task.deliveryGate = null;
    task.finalGate = null;
    task.approvalHash = null;
  } else if (next === STATE.REVIEW && previous !== STATE.REVIEW) {
    task.deliveryGate = null;
    task.finalGate = null;
  } else if (next === STATE.DELIVER && previous !== STATE.DELIVER) {
    task.finalGate = null;
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
  isReviewer,
  isImplementer,
  isDiscussionAgent,
  isDeliveryAgent,
  completionReadiness,
  normalizePhase,
};

/**
 * Process-local collaboration task state (phase 5).
 * Tracks review/implement progress so routes can skip redundant reviewer spins.
 */

"use strict";

const crypto = require("node:crypto");
const { COLLAB_TASK_STATES } = require("../shared/collab-contracts");
const { REVIEWER_AGENT_IDS, IMPLEMENTER_AGENT_IDS } = require("./handoff");

/** @type {Map<string, object>} threadId → task */
const tasksByThread = new Map();

const STATE = Object.freeze({
  PLANNED: "planned",
  IMPLEMENTING: "implementing",
  AWAITING_REVIEW: "awaiting_review",
  CHANGES_REQUESTED: "changes_requested",
  FIXED: "fixed",
  APPROVED: "approved",
  DELIVERED: "delivered",
});

function isReviewer(agentId) {
  return REVIEWER_AGENT_IDS.has(String(agentId || "").toLowerCase());
}

function isImplementer(agentId) {
  return IMPLEMENTER_AGENT_IDS.has(String(agentId || "").toLowerCase());
}

function emptyTask(threadId) {
  return {
    threadId,
    state: STATE.PLANNED,
    goal: null,
    contentHash: null,
    approvalHash: null,
    lastFrom: null,
    lastTo: null,
    updatedAt: new Date().toISOString(),
    history: [],
  };
}

function getTask(threadId) {
  if (!threadId) return null;
  return tasksByThread.get(threadId) || null;
}

function getOrCreateTask(threadId) {
  if (!threadId) return emptyTask("");
  let task = tasksByThread.get(threadId);
  if (!task) {
    task = emptyTask(threadId);
    tasksByThread.set(threadId, task);
  }
  return task;
}

/**
 * Hash a handoff / review evidence blob for approval binding.
 */
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

function pushHistory(task, event) {
  task.history.push({ ...event, at: new Date().toISOString() });
  if (task.history.length > 40) task.history.shift();
  task.updatedAt = new Date().toISOString();
}

/**
 * Infer task transition from a successful A2A route.
 */
function noteAcceptedRoute(input = {}) {
  const threadId = input.threadId;
  if (!threadId) return null;
  const task = getOrCreateTask(threadId);
  const from = String(input.fromAgent || "");
  const to = String(input.toAgent || "");
  const intent = String(input.intent || "");
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

  task.lastFrom = from;
  task.lastTo = to;
  task.contentHash = contentHash || task.contentHash;
  if (handoff.goal) task.goal = handoff.goal;

  let next = task.state;
  if (useWorktree || intent === "implement" || isImplementer(to)) {
    if (task.state === STATE.CHANGES_REQUESTED || task.state === STATE.FIXED) {
      next = STATE.FIXED;
    } else if (task.state === STATE.APPROVED || task.state === STATE.DELIVERED) {
      // new work after approval
      next = STATE.IMPLEMENTING;
      task.approvalHash = null;
    } else {
      next = STATE.IMPLEMENTING;
    }
  }
  if (intent === "review" || isReviewer(to)) {
    next = STATE.AWAITING_REVIEW;
  }
  if (intent === "fix" || (isImplementer(to) && task.state === STATE.CHANGES_REQUESTED)) {
    next = STATE.FIXED;
  }

  // Detect approve / request-changes language on outbound handoff from reviewer
  if (isReviewer(from)) {
    const blob = [handoff.what, handoff.next_action, handoff.goal, input.text]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    if (/request-changes|request_changes|请修|需修改|\bp0\b/.test(blob)) {
      next = STATE.CHANGES_REQUESTED;
      task.approvalHash = null;
    } else if (/approve-with-nits|approve\b|批准|可合入|lgtm/.test(blob)) {
      next = STATE.APPROVED;
      task.approvalHash = evidenceHash;
    }
  }

  if (next !== task.state) {
    pushHistory(task, { type: "transition", from: task.state, to: next, intent, contentHash });
    task.state = next;
  } else {
    pushHistory(task, { type: "route", state: task.state, intent, contentHash });
  }
  return { ...task };
}

/**
 * Mark delivered (optional end of collab).
 */
function markDelivered(threadId) {
  const task = getOrCreateTask(threadId);
  if (task.state === STATE.APPROVED || task.state === STATE.AWAITING_REVIEW) {
    pushHistory(task, { type: "transition", from: task.state, to: STATE.DELIVERED });
    task.state = STATE.DELIVERED;
  }
  return task;
}

/**
 * Skip re-review when already approved for the same evidence hash.
 */
function shouldSkipRedundantReview(input = {}) {
  const task = getTask(input.threadId);
  if (!task) return { skip: false };
  const to = String(input.toAgent || "");
  if (!isReviewer(to) && String(input.intent || "") !== "review") {
    return { skip: false };
  }
  if (task.state !== STATE.APPROVED && task.state !== STATE.DELIVERED) {
    return { skip: false };
  }
  const evidenceHash = hashEvidence({
    contentHash: input.contentHash,
    goal: input.handoff?.goal,
    what: input.handoff?.what,
    diffHash: input.diffHash,
    testHash: input.testHash,
  });
  if (task.approvalHash && task.approvalHash === evidenceHash) {
    return {
      skip: true,
      reason: "already_approved_same_evidence",
      state: task.state,
      approvalHash: task.approvalHash,
    };
  }
  // Approved but evidence changed → allow re-review
  if (task.state === STATE.DELIVERED && !input.force) {
    return { skip: true, reason: "task_delivered", state: task.state };
  }
  return { skip: false, state: task.state };
}

function resetForTests() {
  tasksByThread.clear();
}

module.exports = {
  STATE,
  COLLAB_TASK_STATES,
  getTask,
  getOrCreateTask,
  noteAcceptedRoute,
  markDelivered,
  shouldSkipRedundantReview,
  hashEvidence,
  isReviewer,
  isImplementer,
  resetForTests,
};

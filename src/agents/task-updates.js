"use strict";

const crypto = require("node:crypto");
const { DUTIES } = require("../shared/collab-contracts");
const { hashUserGoal } = require("./workflow-gates");

// Task updates use the registry's existing persist transaction, never a second repository.
function createTaskUpdates({ getOrCreateTask, persist, resetOutcomeEvidence }) {
  function captureUserGoal(threadId, input = {}) {
    if (!threadId) return { captured: false, reason: "missing_thread" };
    const text = String(input.text || "").trim();
    if (!text) return { captured: false, reason: "missing_user_goal" };
    const task = getOrCreateTask(threadId);
    const existing = task.artifacts?.userGoal;
    const updates = task.artifacts?.userUpdates || [];
    if (existing?.hash && !input.force) {
      if (
        !input.messageId ||
        input.messageId === existing.messageId ||
        updates.some((u) => u.messageId === input.messageId)
      ) {
        return { captured: true, reused: true, goalHash: existing.hash, task };
      }
      task.artifacts = {
        ...task.artifacts,
        userUpdates: [...updates, { messageId: input.messageId, text }],
      };
      const saved = persist(task, {
        type: "user_instruction_recorded",
        actorAgentId: "user",
        messageId: input.messageId,
        text,
      });
      return { captured: true, reused: false, goalHash: existing.hash, task: saved };
    }
    task.goalOriginal ||= existing?.text || text;
    if (input.force) resetOutcomeEvidence(task);
    const goalHash = hashUserGoal(text);
    task.goal = text;
    task.goalHash = goalHash;
    task.goalNormalized = text;
    task.artifacts = {
      ...task.artifacts,
      userGoal: {
        text,
        hash: goalHash,
        messageId: input.messageId || null,
        capturedAt: new Date().toISOString(),
      },
    };
    delete task.artifacts.acceptanceDecision;
    const saved = persist(task, {
      type: "user_goal_captured",
      from: task.phase,
      to: task.phase,
      actorAgentId: "user",
      intent: "discuss",
      goalHash,
      messageId: input.messageId,
      text,
    });
    return { captured: true, reused: false, goalHash, task: saved };
  }

  function submitTaskUpdate(threadId, input = {}) {
    const reject = (reason) => ({ accepted: false, reason });
    if (!threadId || !input.invocationId || !input.seatId || !DUTIES.includes(input.actorDuty))
      return reject("missing_task_update_identity");
    const value = input.value;
    if (!value || typeof value !== "object" || Array.isArray(value))
      return reject("invalid_task_update");
    const task = getOrCreateTask(threadId);
    const updateHash = crypto
      .createHash("sha256")
      .update(JSON.stringify({ type: input.type, value }))
      .digest("hex");
    const seen = task.history?.some((event) => {
      const payload = event.payload || event;
      return payload.invocationId === input.invocationId && payload.updateHash === updateHash;
    });
    if (seen) return { accepted: true, reused: true, task };
    if (!task.artifacts?.userGoal?.hash || value.goal_hash !== task.artifacts.userGoal.hash)
      return reject("task_goal_mismatch");
    const previousGoalHash = task.artifacts.userGoal.hash;
    if (input.type === "task_goal") {
      if (!["discuss", "plan", "accept"].includes(input.actorDuty))
        return reject("goal_revision_requires_planning_duty");
      if (!hasOnly(value, ["goal_hash", "text", "source_message_id"]) || !text(value.text))
        return reject("invalid_goal_revision");
      const sources = [task.artifacts.userGoal, ...(task.artifacts.userUpdates || [])];
      const source = sources.find((m) => m.messageId && m.messageId === value.source_message_id);
      if (!source) return reject("goal_revision_requires_user_message");
      const updates = task.artifacts.userUpdates || [];
      const original = task.goalOriginal || task.artifacts.userGoal.text;
      resetOutcomeEvidence(task);
      task.goalOriginal = original;
      task.goal = value.text.trim();
      task.goalNormalized = task.goal;
      task.goalHash = hashUserGoal(task.goal);
      task.artifacts = {
        userUpdates: updates,
        userGoal: {
          text: task.goal,
          hash: task.goalHash,
          messageId: source.messageId,
          sourceText: source.text,
          capturedAt: new Date().toISOString(),
        },
      };
    } else if (input.type === "task_progress") {
      if (!validProgress(value)) return reject("invalid_task_progress");
      if (value.plan_hash !== (task.artifacts.implementationPlan?.hash || null))
        return reject("task_plan_mismatch");
      task.artifacts = {
        ...task.artifacts,
        progress: {
          ...value,
          sourceInvocationId: input.invocationId,
          seatId: input.seatId,
          duty: input.actorDuty,
          reportedAt: new Date().toISOString(),
          evidenceLevel: "agent_reported",
        },
      };
    } else return reject("unknown_task_update");
    const saved = persist(task, {
      type: `${input.type}_updated`,
      actorKind: "seat",
      actorId: input.seatId,
      actorAgentId: input.actorAgentId,
      duty: input.actorDuty,
      invocationId: input.invocationId,
      updateHash,
      previousGoalHash,
      goalHash: task.artifacts.userGoal.hash,
      value,
    });
    return { accepted: true, reused: false, task: saved };
  }
  return { captureUserGoal, submitTaskUpdate };
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 4000;
}
function list(value) {
  return Array.isArray(value) && value.length <= 50 && value.every(text);
}
function hasOnly(value, keys) {
  return Object.keys(value).every((key) => keys.includes(key));
}
function validProgress(value) {
  return (
    hasOnly(value, [
      "goal_hash",
      "plan_hash",
      "current",
      "completed",
      "remaining",
      "blockers",
      "next_action",
      "verification",
    ]) &&
    text(value.current) &&
    text(value.next_action) &&
    list(value.remaining) &&
    list(value.blockers) &&
    list(value.verification) &&
    Array.isArray(value.completed) &&
    value.completed.length <= 50 &&
    value.completed.every(
      (item) =>
        item &&
        hasOnly(item, ["item", "evidence"]) &&
        text(item.item) &&
        list(item.evidence) &&
        item.evidence.length > 0
    )
  );
}

function parseTaskUpdates(content) {
  const updates = [];
  const pattern = /```(task_goal|task_progress)\s*\r?\n([\s\S]*?)```/g;
  for (const match of String(content || "").matchAll(pattern)) {
    let value = null;
    try {
      value = JSON.parse(match[2]);
    } catch {
      /* Invalid evidence is explicitly rejected by the registry. */
    }
    updates.push({ type: match[1], value });
  }
  return updates;
}

module.exports = { createTaskUpdates, parseTaskUpdates };

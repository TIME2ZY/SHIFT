"use strict";

const crypto = require("node:crypto");
const {
  normalizeDelegationContract,
  DEFAULT_DELEGATION_POLICY,
} = require("../shared/delegation-contracts");

function createDelegationQueue({ db, get, save }) {
  const find = db.prepare("SELECT * FROM collaboration_tasks WHERE thread_id = ?");
  const active = db.prepare(
    "SELECT thread_id FROM collaboration_tasks WHERE delegation_state IN ('running','cancelling') LIMIT 1"
  );
  const queued = db.prepare(
    "SELECT thread_id FROM collaboration_tasks WHERE delegation_state = 'queued' ORDER BY queue_seq LIMIT 1"
  );
  const event = db.prepare(`
    INSERT INTO collaboration_task_events (thread_id,event_type,payload_json,created_at,actor_kind,actor_id)
    VALUES (@threadId,@type,@payload,@now,'system','platform')
  `);
  function change(threadId, patch, type, payload = {}) {
    return db.transaction(() => {
      const now = new Date().toISOString();
      const entries = Object.entries({ ...patch, updated_at: now });
      db.prepare(
        "UPDATE collaboration_tasks SET " +
          entries.map(([key]) => key + " = ?").join(", ") +
          ", version = version + 1 WHERE thread_id = ?"
      ).run(...entries.map(([, value]) => value), threadId);
      event.run({ threadId, type, payload: JSON.stringify(payload), now });
      return get(threadId);
    })();
  }
  function requireDraft(threadId, revision) {
    const row = find.get(threadId);
    if (!row) throw failure("TASK_NOT_FOUND", "任务不存在。", 404);
    if (row.delegation_state !== "draft")
      throw failure("TASK_FROZEN", "委托已提交，需求变更请建立关联新任务。");
    if (!Number.isInteger(revision) || revision !== row.version)
      throw failure("TASK_REVISION_CONFLICT", "草稿已更新，请刷新后重试。");
    return row;
  }
  const api = {
    initialize(threadId, { parentThreadId = null } = {}) {
      return db
        .transaction(() => {
          if (get(threadId)?.delegationState) return get(threadId);
          if (parentThreadId && !find.get(parentThreadId))
            throw failure("TASK_NOT_FOUND", "关联来源任务不存在。", 404);
          save({ threadId, phase: "discuss" });
          return change(
            threadId,
            { delegation_state: "draft", parent_thread_id: parentThreadId },
            "delegation_created"
          );
        })
        .immediate();
    },
    saveDraft(threadId, contract, expectedRevision) {
      return db
        .transaction(() => {
          requireDraft(threadId, expectedRevision);
          const normalized = normalizeDelegationContract(contract);
          const current = get(threadId);
          const goalHash = hash(normalized.goal, 16);
          save(
            {
              ...current,
              goal: normalized.goal,
              goalNormalized: normalized.goal,
              goalHash,
              artifacts: {
                userGoal: { text: normalized.goal, hash: goalHash },
                userUpdates: current.artifacts.userUpdates || [],
              },
              implementationGate: null,
              codeReviewGate: null,
              deliveryGate: null,
              finalGate: null,
              taskStatus: "active",
            },
            { type: "delegation_draft_updated", payload: { goalHash } }
          );
          return change(
            threadId,
            { contract_json: JSON.stringify(normalized), delegation_reason: null },
            "delegation_contract_prepared"
          );
        })
        .immediate();
    },
    submit(threadId, expectedRevision, team) {
      return db
        .transaction(() => {
          const existing = find.get(threadId);
          if (existing?.submitted_at) return get(threadId);
          const row = requireDraft(threadId, expectedRevision);
          const contract = normalizeDelegationContract(JSON.parse(row.contract_json || "null"));
          if (!team?.bindings?.discuss || !team?.bindings?.accept)
            throw failure("INVALID_TEAM", "缺少执行或验收席位。", 400);
          const seq = db
            .prepare("SELECT COALESCE(MAX(queue_seq),0)+1 AS seq FROM collaboration_tasks")
            .get().seq;
          return change(
            threadId,
            {
              contract_json: JSON.stringify(contract),
              contract_hash: hash(JSON.stringify(contract)),
              team_json: JSON.stringify(team),
              queue_seq: seq,
              delegation_state: "queued",
              submitted_at: new Date().toISOString(),
            },
            "delegation_submitted",
            { queueSeq: seq }
          );
        })
        .immediate();
    },
    claimNext() {
      return db
        .transaction(() => {
          if (active.get()) return null;
          const next = queued.get();
          if (!next) return null;
          const deadline = new Date(
            Date.now() + DEFAULT_DELEGATION_POLICY.deadlineMs
          ).toISOString();
          return change(
            next.thread_id,
            { delegation_state: "running", deadline_at: deadline },
            "delegation_claimed"
          );
        })
        .immediate();
    },
    bindTrace(threadId, traceId) {
      const row = find.get(threadId);
      if (!row || !["running", "cancelling"].includes(row.delegation_state))
        throw failure("TASK_NOT_RUNNING", "任务未执行。");
      return change(threadId, { execution_trace_id: traceId }, "delegation_trace_bound", {
        traceId,
      });
    },
    preparationFailed(threadId, reason) {
      if (find.get(threadId)?.delegation_state !== "draft") return get(threadId);
      return change(threadId, { delegation_reason: reason }, "delegation_preparation_failed", {
        reason,
      });
    },
    recordRepair(threadId) {
      const row = find.get(threadId);
      if (!row || row.delegation_state !== "running")
        throw failure("TASK_NOT_RUNNING", "任务未执行。");
      return change(
        threadId,
        { repair_count: row.repair_count + 1 },
        "delegation_repair_requested"
      );
    },
    cancel(threadId) {
      return db
        .transaction(() => {
          const row = find.get(threadId);
          if (!row) throw failure("TASK_NOT_FOUND", "任务不存在。", 404);
          if (["completed", "failed", "cancelled", "cancelling"].includes(row.delegation_state))
            return get(threadId);
          const state = row.delegation_state === "running" ? "cancelling" : "cancelled";
          return change(
            threadId,
            { delegation_state: state, delegation_reason: "user_cancelled" },
            "delegation_cancel_requested"
          );
        })
        .immediate();
    },
    finish(threadId, { state, reason = null, result = null }) {
      return db
        .transaction(() => {
          const row = find.get(threadId);
          if (!row || !["running", "cancelling"].includes(row.delegation_state))
            return get(threadId);
          if (!["completed", "failed", "cancelled"].includes(state))
            throw failure("INVALID_TERMINAL", "任务终态无效。", 400);
          if (row.delegation_state === "cancelling") state = "cancelled";
          if (state === "completed") {
            const task = get(threadId);
            const decision = task.artifacts?.acceptanceDecision;
            if (
              task.taskStatus !== "accepted" ||
              decision?.verdict !== "accepted" ||
              decision.goalHash !== task.goalHash ||
              !task.finalGate?.solutionHash ||
              task.finalGate.solutionHash !== task.artifacts?.solutionBaseline?.hash ||
              !decision.planHash ||
              decision.planHash !== task.artifacts?.implementationPlan?.hash ||
              !decision.commitSha ||
              decision.commitSha !== task.deliveryGate?.commitSha
            ) {
              throw failure("ACCEPTANCE_REQUIRED", "完成需要匹配冻结目标的 Agent 验收证据。");
            }
          }
          return change(
            threadId,
            {
              delegation_state: state,
              delegation_reason: reason,
              result_json: result ? JSON.stringify(result) : null,
            },
            "delegation_finished",
            { state, reason }
          );
        })
        .immediate();
    },
    reconcile() {
      return db
        .transaction(() => {
          const rows = db
            .prepare(
              "SELECT thread_id,delegation_state FROM collaboration_tasks WHERE delegation_state IN ('running','cancelling')"
            )
            .all();
          for (const row of rows)
            change(
              row.thread_id,
              {
                delegation_state: row.delegation_state === "cancelling" ? "cancelled" : "failed",
                delegation_reason: "application_interrupted",
              },
              "delegation_interrupted"
            );
          return rows.length;
        })
        .immediate();
    },
    list() {
      return db
        .prepare(
          "SELECT thread_id FROM collaboration_tasks WHERE delegation_state IS NOT NULL ORDER BY created_at DESC,thread_id"
        )
        .all()
        .map((row) => get(row.thread_id));
    },
  };
  return api;
}
function hash(value, length = 64) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, length);
}
function failure(code, message, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}
module.exports = { createDelegationQueue, failure };

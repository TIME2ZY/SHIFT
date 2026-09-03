"use strict";

const {
  COLLAB_ACTOR_KINDS,
  COLLAB_TASK_STATES,
  DUTIES,
  EVIDENCE_PROFILES,
  HANDOFF_INTENTS,
  TASK_STATUSES,
} = require("../shared/collab-contracts");

function createCollaborationTaskRepository(db) {
  const find = db.prepare("SELECT * FROM collaboration_tasks WHERE thread_id = ?");
  const upsert = db.prepare(`
    INSERT INTO collaboration_tasks (
      thread_id, phase, goal, content_hash, approval_hash,
      last_from_agent_id, last_to_agent_id, artifacts_json,
      implementation_gate_json, code_review_gate_json,
      delivery_gate_json, final_gate_json,
      task_status, goal_original, goal_normalized, goal_hash, evidence_profile,
      created_at, updated_at, version
    ) VALUES (
      @threadId, @phase, @goal, @contentHash, @approvalHash,
      @lastFrom, @lastTo, @artifactsJson,
      @implementationGateJson, @codeReviewGateJson,
      @deliveryGateJson, @finalGateJson,
      @taskStatus, @goalOriginal, @goalNormalized, @goalHash, @evidenceProfile,
      @createdAt, @updatedAt, 1
    )
    ON CONFLICT(thread_id) DO UPDATE SET
      phase = excluded.phase,
      goal = excluded.goal,
      content_hash = excluded.content_hash,
      approval_hash = excluded.approval_hash,
      last_from_agent_id = excluded.last_from_agent_id,
      last_to_agent_id = excluded.last_to_agent_id,
      artifacts_json = excluded.artifacts_json,
      implementation_gate_json = excluded.implementation_gate_json,
      code_review_gate_json = excluded.code_review_gate_json,
      delivery_gate_json = excluded.delivery_gate_json,
      final_gate_json = excluded.final_gate_json,
      task_status = excluded.task_status,
      goal_original = COALESCE(collaboration_tasks.goal_original, excluded.goal_original),
      goal_normalized = COALESCE(excluded.goal_normalized, collaboration_tasks.goal_normalized),
      goal_hash = COALESCE(excluded.goal_hash, collaboration_tasks.goal_hash),
      evidence_profile = excluded.evidence_profile,
      updated_at = excluded.updated_at,
      version = collaboration_tasks.version + 1
  `);
  const insertEvent = db.prepare(`
    INSERT INTO collaboration_task_events (
      thread_id, event_type, from_phase, to_phase,
      actor_agent_id, intent, payload_json, created_at,
      actor_kind, actor_id, duty
    ) VALUES (
      @threadId, @eventType, @fromPhase, @toPhase,
      @actorAgentId, @intent, @payloadJson, @createdAt,
      @actorKind, @actorId, @duty
    )
  `);
  const listEvents = db.prepare(`
    SELECT * FROM collaboration_task_events
    WHERE thread_id = ?
    ORDER BY id ASC
  `);
  const deleteEvents = db.prepare("DELETE FROM collaboration_task_events WHERE thread_id = ?");
  const deleteTask = db.prepare("DELETE FROM collaboration_tasks WHERE thread_id = ?");

  const saveTransaction = db.transaction((task, event) => {
    const threadId = requiredString(task?.threadId, "thread id");
    const record = normalizeTask(task, find.get(threadId));
    upsert.run(record);
    if (event) insertEvent.run(normalizeEvent(record.threadId, event));
    return mapTask(find.get(record.threadId), listEvents.all(record.threadId));
  });

  return {
    get(threadId) {
      const id = requiredString(threadId, "thread id");
      const row = find.get(id);
      return row ? mapTask(row, listEvents.all(id)) : null;
    },

    save(task, event = null) {
      return saveTransaction(task, event);
    },

    listEvents(threadId) {
      return listEvents.all(requiredString(threadId, "thread id")).map(mapEvent);
    },

    delete(threadId) {
      const id = requiredString(threadId, "thread id");
      return db.transaction(() => {
        deleteEvents.run(id);
        return deleteTask.run(id).changes > 0;
      })();
    },
  };
}

function normalizeTask(input = {}, current = null) {
  const now = input.updatedAt || new Date().toISOString();
  const phase = String(input.phase || input.state || "discuss")
    .trim()
    .toLowerCase();
  if (!COLLAB_TASK_STATES.includes(phase)) {
    throw new Error(`Unsupported collaboration phase: ${phase || "(missing)"}`);
  }
  const artifacts = input.artifacts && typeof input.artifacts === "object" ? input.artifacts : {};
  const taskStatus = enumValue(
    phase === "done" ? "accepted" : input.taskStatus || current?.task_status || "active",
    TASK_STATUSES,
    "task status"
  );
  const evidenceProfile = enumValue(
    input.evidenceProfile || current?.evidence_profile || "code_change",
    EVIDENCE_PROFILES,
    "evidence profile"
  );
  return {
    threadId: requiredString(input.threadId, "thread id"),
    phase,
    goal: nullableString(input.goal),
    contentHash: nullableString(input.contentHash),
    approvalHash: nullableString(input.approvalHash),
    lastFrom: nullableString(input.lastFrom),
    lastTo: nullableString(input.lastTo),
    artifactsJson: stringifyObject(artifacts),
    implementationGateJson: stringifyNullableObject(input.implementationGate),
    codeReviewGateJson: stringifyNullableObject(input.codeReviewGate),
    deliveryGateJson: stringifyNullableObject(input.deliveryGate),
    finalGateJson: stringifyNullableObject(input.finalGate),
    taskStatus,
    goalOriginal: nullableString(
      input.goalOriginal || current?.goal_original || artifacts.userGoal?.text
    ),
    goalNormalized: nullableString(input.goalNormalized || input.goal || current?.goal_normalized),
    goalHash: nullableString(input.goalHash || artifacts.userGoal?.hash || current?.goal_hash),
    evidenceProfile,
    createdAt: input.createdAt || now,
    updatedAt: now,
  };
}

function normalizeEvent(threadId, input = {}) {
  const intent = nullableString(input.intent)?.toLowerCase() || null;
  if (intent && !HANDOFF_INTENTS.includes(intent)) {
    throw new Error(`Unsupported handoff intent: ${intent}`);
  }
  const actorKind = input.actorKind
    ? enumValue(input.actorKind, COLLAB_ACTOR_KINDS, "actor kind")
    : null;
  const actorId = nullableString(input.actorId);
  if (actorKind && !actorId) throw new Error("actor id is required when actor kind is set.");
  const duty = input.duty ? enumValue(input.duty, DUTIES, "duty") : null;
  return {
    threadId,
    eventType: requiredString(input.type || input.eventType, "event type"),
    fromPhase: nullablePhase(input.from || input.fromPhase),
    toPhase: nullablePhase(input.to || input.toPhase),
    actorAgentId: nullableString(input.actorAgentId || input.actor),
    actorKind,
    actorId,
    duty,
    intent,
    payloadJson: stringifyObject(input.payload || eventPayload(input)),
    createdAt: input.at || input.createdAt || new Date().toISOString(),
  };
}

function eventPayload(input) {
  const omitted = new Set([
    "type",
    "eventType",
    "from",
    "fromPhase",
    "to",
    "toPhase",
    "actorAgentId",
    "actor",
    "actorKind",
    "actorId",
    "duty",
    "intent",
    "at",
    "createdAt",
  ]);
  return Object.fromEntries(Object.entries(input).filter(([key]) => !omitted.has(key)));
}

function mapTask(row, events = []) {
  if (!row) return null;
  const phase = row.phase;
  return {
    threadId: row.thread_id,
    phase,
    state: phase,
    goal: row.goal || null,
    contentHash: row.content_hash || null,
    approvalHash: row.approval_hash || null,
    lastFrom: row.last_from_agent_id || null,
    lastTo: row.last_to_agent_id || null,
    artifacts: parseObject(row.artifacts_json),
    implementationGate: parseNullableObject(row.implementation_gate_json),
    codeReviewGate: parseNullableObject(row.code_review_gate_json),
    deliveryGate: parseNullableObject(row.delivery_gate_json),
    finalGate: parseNullableObject(row.final_gate_json),
    taskStatus: row.task_status || (phase === "done" ? "accepted" : "active"),
    goalOriginal: row.goal_original || null,
    goalNormalized: row.goal_normalized || null,
    goalHash: row.goal_hash || null,
    evidenceProfile: row.evidence_profile || "code_change",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: Number(row.version || 1),
    history: events.map(mapEvent),
  };
}

function mapEvent(row) {
  return {
    id: row.id,
    type: row.event_type,
    from: row.from_phase || null,
    to: row.to_phase || null,
    actorAgentId: row.actor_agent_id || null,
    actorKind: row.actor_kind || null,
    actorId: row.actor_id || null,
    duty: row.duty || null,
    intent: row.intent || null,
    payload: parseObject(row.payload_json),
    at: row.created_at,
  };
}

function nullablePhase(value) {
  const phase = nullableString(value)?.toLowerCase() || null;
  if (phase && !COLLAB_TASK_STATES.includes(phase)) {
    throw new Error(`Unsupported collaboration phase: ${phase}`);
  }
  return phase;
}

function stringifyObject(value) {
  return JSON.stringify(value && typeof value === "object" && !Array.isArray(value) ? value : {});
}

function stringifyNullableObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? JSON.stringify(value) : null;
}

function parseObject(value) {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function parseNullableObject(value) {
  if (!value) return null;
  return parseObject(value);
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function nullableString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function enumValue(value, allowed, label) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!allowed.includes(normalized)) throw new Error(`Unsupported ${label}: ${normalized}`);
  return normalized;
}

module.exports = {
  createCollaborationTaskRepository,
  mapEvent,
  mapTask,
  normalizeEvent,
  normalizeTask,
};

/**
 * Process-local A2A handoff route registry: identity, idempotency, hop lifecycle.
 * Phase 3 — not durable across restarts; enough to stop double-route within a process.
 */

"use strict";

const crypto = require("node:crypto");
const {
  HANDOFF_COMPLETE_STATUS,
  HANDOFF_PARSE_STATUS,
  HANDOFF_ROUTE_STATUS,
  isEffectiveA2aHop,
} = require("../shared/collab-contracts");

/** @type {Map<string, object>} flightKey sourceInvocation::target → record */
const byFlightKey = new Map();
/** @type {Map<string, object>} handoffId → record */
const byHandoffId = new Map();
/** @type {Map<string, string>} targetInvocationId → handoffId */
const byTargetInvocation = new Map();
/** @type {Map<string, object>} contentKey target::contentHash → last completed record */
const byContentCompleted = new Map();

function makeHandoffId() {
  return `h-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Stable short hash of handoff body + target (for already_completed / metrics).
 * @param {object|null} handoff
 * @param {string} targetAgent
 */
function hashHandoffContent(handoff, targetAgent) {
  const h = handoff && typeof handoff === "object" ? handoff : {};
  const parts = [
    String(targetAgent || "").toLowerCase(),
    String(h.to || ""),
    String(h.goal || ""),
    String(h.what || ""),
    String(h.why || ""),
    String(h.next_action || ""),
  ];
  return crypto.createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

function flightKey(sourceInvocationId, targetAgent) {
  return `${String(sourceInvocationId || "?")}::${String(targetAgent || "").toLowerCase()}`;
}

function contentKey(targetAgent, contentHash) {
  return `${String(targetAgent || "").toLowerCase()}::${String(contentHash || "empty")}`;
}

/**
 * Attempt to accept a route. One accepted hop per (sourceInvocation, target).
 * Same content already completed for target → already_completed.
 *
 * @returns {{
 *   status: string,
 *   record: object,
 *   accepted: boolean,
 * }}
 */
function tryAcceptRoute(input = {}) {
  const sourceAgent = String(input.sourceAgent || "");
  const targetAgent = String(input.targetAgent || "");
  const sourceInvocationId = input.sourceInvocationId || null;
  const contentHash =
    input.contentHash || hashHandoffContent(input.handoff, targetAgent);
  const depth = Number.isFinite(Number(input.depth)) ? Number(input.depth) : 0;
  const parseStatus = input.parseStatus || HANDOFF_PARSE_STATUS.PARSED;
  const goal =
    input.handoff && typeof input.handoff.goal === "string" ? input.handoff.goal : null;
  const reason = input.reason || "a2a-route";
  const source = input.source || "chat";

  const completedPrior = byContentCompleted.get(contentKey(targetAgent, contentHash));
  if (completedPrior && completedPrior.completeStatus === HANDOFF_COMPLETE_STATUS.COMPLETED) {
    const dup = {
      ...completedPrior,
      routeStatus: HANDOFF_ROUTE_STATUS.ALREADY_COMPLETED,
      duplicateOf: completedPrior.handoffId,
      source,
    };
    return { status: HANDOFF_ROUTE_STATUS.ALREADY_COMPLETED, record: dup, accepted: false };
  }

  const fKey = flightKey(sourceInvocationId, targetAgent);
  const existing = byFlightKey.get(fKey);
  if (existing) {
    const dup = {
      ...existing,
      routeStatus:
        existing.completeStatus === HANDOFF_COMPLETE_STATUS.COMPLETED
          ? HANDOFF_ROUTE_STATUS.ALREADY_COMPLETED
          : HANDOFF_ROUTE_STATUS.DUPLICATE,
      duplicateOf: existing.handoffId,
      source,
    };
    return {
      status: dup.routeStatus,
      record: dup,
      accepted: false,
    };
  }

  const handoffId = input.handoffId || makeHandoffId();
  const record = {
    handoffId,
    sourceAgent,
    targetAgent,
    sourceInvocationId,
    targetInvocationId: null,
    reason,
    depth,
    parseStatus,
    routeStatus: HANDOFF_ROUTE_STATUS.ACCEPTED,
    receiveStatus: null,
    completeStatus: HANDOFF_COMPLETE_STATUS.PENDING,
    contentHash,
    duplicateOf: null,
    goal,
    phaseId: input.phaseId || null,
    source,
    policy: input.policy || null,
    createdAt: new Date().toISOString(),
  };
  byFlightKey.set(fKey, record);
  byHandoffId.set(handoffId, record);
  return { status: HANDOFF_ROUTE_STATUS.ACCEPTED, record, accepted: true };
}

/**
 * Bind the child invocation once it starts (A2A receive).
 */
function bindTargetInvocation({
  sourceInvocationId,
  targetAgent,
  targetInvocationId,
  handoffId,
} = {}) {
  let record = handoffId ? byHandoffId.get(handoffId) : null;
  if (!record && sourceInvocationId && targetAgent) {
    record = byFlightKey.get(flightKey(sourceInvocationId, targetAgent)) || null;
  }
  if (!record || !targetInvocationId) return null;
  record.targetInvocationId = targetInvocationId;
  record.receiveStatus = "started";
  byTargetInvocation.set(targetInvocationId, record.handoffId);
  return record;
}

/**
 * Mark hop complete when the target invocation ends.
 */
function completeByTargetInvocation(targetInvocationId, { ok = true } = {}) {
  const handoffId = byTargetInvocation.get(targetInvocationId);
  if (!handoffId) return null;
  const record = byHandoffId.get(handoffId);
  if (!record) return null;
  record.completeStatus = ok
    ? HANDOFF_COMPLETE_STATUS.COMPLETED
    : HANDOFF_COMPLETE_STATUS.FAILED;
  record.completedAt = new Date().toISOString();
  if (record.completeStatus === HANDOFF_COMPLETE_STATUS.COMPLETED) {
    byContentCompleted.set(contentKey(record.targetAgent, record.contentHash), record);
  }
  return record;
}

function getRecord(handoffId) {
  return byHandoffId.get(handoffId) || null;
}

function listRecords() {
  return [...byHandoffId.values()];
}

function listEffectiveHops() {
  return listRecords().filter((r) => isEffectiveA2aHop(r));
}

/** Test / process shutdown helper */
function resetForTests() {
  byFlightKey.clear();
  byHandoffId.clear();
  byTargetInvocation.clear();
  byContentCompleted.clear();
}

module.exports = {
  makeHandoffId,
  hashHandoffContent,
  flightKey,
  tryAcceptRoute,
  bindTargetInvocation,
  completeByTargetInvocation,
  getRecord,
  listRecords,
  listEffectiveHops,
  resetForTests,
  HANDOFF_ROUTE_STATUS,
  HANDOFF_COMPLETE_STATUS,
  HANDOFF_PARSE_STATUS,
  isEffectiveA2aHop,
};

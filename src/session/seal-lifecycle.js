/**
 * Seal / rotate capacity and completeness helpers (phase 6).
 */

"use strict";

/**
 * Capacity for a **new** generation after seal.
 * Prefer live agent capacity (incl. SHIFT_TEST_CAPACITY) over sticky sealed-window capacity.
 *
 * @param {object} input
 * @param {string} input.agentId
 * @param {(id: string) => number} input.getAgentCapacity
 * @param {number} [input.previousCapacity] sealed window capacity (fallback only)
 * @param {number} [input.explicitCapacity] API override wins
 */
function resolveRotateCapacity(input = {}) {
  if (Number.isFinite(Number(input.explicitCapacity)) && Number(input.explicitCapacity) > 0) {
    return Math.floor(Number(input.explicitCapacity));
  }
  const getter = input.getAgentCapacity;
  if (typeof getter === "function" && input.agentId) {
    const live = Number(getter(input.agentId));
    if (Number.isFinite(live) && live > 0) return Math.floor(live);
  }
  const prev = Number(input.previousCapacity);
  if (Number.isFinite(prev) && prev > 0) return Math.floor(prev);
  return 128_000;
}

/**
 * @param {object} input
 * @param {boolean} [input.partial] mid-stream / incomplete answer
 * @param {string} [input.reason]
 * @param {number} [input.ratio]
 * @param {string[]} [input.missingFields]
 * @param {string} [input.workspaceKey]
 * @param {number} [input.generation]
 * @param {number} [input.nextCapacityTokens]
 */
function buildSealMeta(input = {}) {
  const partial = Boolean(input.partial);
  const missingFields = Array.isArray(input.missingFields)
    ? input.missingFields.filter(Boolean)
    : [];
  return {
    partial,
    complete: !partial,
    reason: input.reason || null,
    ratio: typeof input.ratio === "number" ? input.ratio : null,
    missingFields,
    workspaceKey: input.workspaceKey || null,
    generation: input.generation ?? null,
    nextCapacityTokens: input.nextCapacityTokens ?? null,
    sealedAt: input.sealedAt || new Date().toISOString(),
  };
}

/**
 * Encode completeness into seal_reason for DB (no migration).
 * e.g. "post-turn-soft|complete" or "physical-ceiling|partial"
 */
function formatSealReason(reason, partial) {
  const base = String(reason || "context-seal").replace(/\|/g, "/");
  return `${base}|${partial ? "partial" : "complete"}`;
}

function parseSealReason(reason) {
  const raw = String(reason || "");
  const idx = raw.lastIndexOf("|");
  if (idx < 0) {
    return { reason: raw || null, partial: null, complete: null };
  }
  const flag = raw.slice(idx + 1);
  const base = raw.slice(0, idx);
  if (flag === "partial") return { reason: base, partial: true, complete: false };
  if (flag === "complete") return { reason: base, partial: false, complete: true };
  return { reason: raw, partial: null, complete: null };
}

/**
 * Window identity key for multi-active agents (base vs worktree).
 */
function windowCoordinateKey({ threadId, agentId, providerKey, workspaceKey }) {
  return [threadId, agentId, providerKey, workspaceKey].map((p) => String(p || "")).join("::");
}

/**
 * Lightweight seal recovery check: facts present in a digest/text after rotate.
 * @param {object} input
 * @param {string[]} input.facts required substrings
 * @param {string} input.recoveredText post-seal context (bootstrap / memory card)
 * @returns {{ ok: boolean, missing: string[], present: string[] }}
 */
function checkSealRecoveryFacts(input = {}) {
  const facts = Array.isArray(input.facts) ? input.facts.filter(Boolean) : [];
  const text = String(input.recoveredText || "");
  const present = [];
  const missing = [];
  for (const fact of facts) {
    if (text.includes(fact)) present.push(fact);
    else missing.push(fact);
  }
  return { ok: missing.length === 0, missing, present };
}

module.exports = {
  resolveRotateCapacity,
  buildSealMeta,
  formatSealReason,
  parseSealReason,
  windowCoordinateKey,
  checkSealRecoveryFacts,
};

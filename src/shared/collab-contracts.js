/**
 * Multi-agent reliability contracts.
 *
 * Canonical enums and payload shapes for invocation lifecycle, A2A handoff
 * closed-loop hops, memory funnel metrics, collab task/phase policy, and live
 * report schemas. Runtime wiring lives in storage/agents/server; this module
 * is the single source of names.
 *
 * @see docs/decisions/002-multi-agent-reliability-contracts.md
 * @see docs/decisions/007-seat-duty-evidence-workflow.md
 */

"use strict";

// ── Invocation lifecycle ────────────────────────────────────────────────────

/**
 * Canonical invocation states (product / SSE / future unified API).
 * Map to DB via toDbInvocationState until schema migration expands CHECK.
 */
const INVOCATION_STATES = Object.freeze({
  CREATED: "created",
  STARTED: "started",
  STREAMING: "streaming",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  /** Terminal reason only in canonical API; DB stores completed + terminalReason. */
  SEALED: "sealed",
});

/** States that mean the invocation will never emit more agent work. */
const TERMINAL_INVOCATION_STATES = Object.freeze([
  INVOCATION_STATES.COMPLETED,
  INVOCATION_STATES.FAILED,
  INVOCATION_STATES.CANCELLED,
  INVOCATION_STATES.SEALED,
]);

/**
 * Current SQLite CHECK on invocations.state.
 * Canonical states map onto these DB values; expanding CHECK needs a migration.
 */
const LEGACY_DB_INVOCATION_STATES = Object.freeze(["active", "completed", "failed", "aborted"]);

/** Allowed canonical transitions (from → to[]). Missing from = any create. */
const INVOCATION_TRANSITIONS = Object.freeze({
  [INVOCATION_STATES.CREATED]: [
    INVOCATION_STATES.STARTED,
    INVOCATION_STATES.FAILED,
    INVOCATION_STATES.CANCELLED,
  ],
  [INVOCATION_STATES.STARTED]: [
    INVOCATION_STATES.STREAMING,
    INVOCATION_STATES.COMPLETED,
    INVOCATION_STATES.FAILED,
    INVOCATION_STATES.CANCELLED,
    INVOCATION_STATES.SEALED,
  ],
  [INVOCATION_STATES.STREAMING]: [
    INVOCATION_STATES.COMPLETED,
    INVOCATION_STATES.FAILED,
    INVOCATION_STATES.CANCELLED,
    INVOCATION_STATES.SEALED,
  ],
  [INVOCATION_STATES.COMPLETED]: [],
  [INVOCATION_STATES.FAILED]: [],
  [INVOCATION_STATES.CANCELLED]: [],
  [INVOCATION_STATES.SEALED]: [],
});

/**
 * Map canonical state → current DB column value.
 * sealed → completed (caller should also persist terminalReason: "sealed").
 * cancelled → aborted.
 * created/started/streaming → active.
 */
function toDbInvocationState(canonical) {
  const s = String(canonical || "");
  if (s === INVOCATION_STATES.CANCELLED) return "aborted";
  if (s === INVOCATION_STATES.SEALED) return "completed";
  if (s === INVOCATION_STATES.COMPLETED) return "completed";
  if (s === INVOCATION_STATES.FAILED) return "failed";
  if (
    s === INVOCATION_STATES.CREATED ||
    s === INVOCATION_STATES.STARTED ||
    s === INVOCATION_STATES.STREAMING ||
    s === "active"
  ) {
    return "active";
  }
  if (LEGACY_DB_INVOCATION_STATES.includes(s)) return s;
  throw new Error(`Unknown canonical invocation state: ${canonical}`);
}

/**
 * Map DB state (+ optional terminalReason) → canonical state.
 * @param {string} dbState
 * @param {{ terminalReason?: string|null }} [meta]
 */
function fromDbInvocationState(dbState, meta = {}) {
  const s = String(dbState || "");
  if (s === "aborted") return INVOCATION_STATES.CANCELLED;
  if (s === "failed") return INVOCATION_STATES.FAILED;
  if (s === "completed") {
    if (String(meta.terminalReason || "") === "sealed") {
      return INVOCATION_STATES.SEALED;
    }
    return INVOCATION_STATES.COMPLETED;
  }
  if (s === "active") {
    // Sub-states are not stored in DB yet; default to started for readers.
    return INVOCATION_STATES.STARTED;
  }
  if (Object.values(INVOCATION_STATES).includes(s)) return s;
  throw new Error(`Unknown DB invocation state: ${dbState}`);
}

function isTerminalInvocationState(state) {
  const s = String(state || "");
  if (TERMINAL_INVOCATION_STATES.includes(s)) return true;
  if (s === "aborted" || s === "completed" || s === "failed") return true;
  return false;
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {{ ok: boolean, reason?: string }}
 */
function assertValidTransition(from, to) {
  const f = String(from || "");
  const t = String(to || "");
  if (!f) {
    const ok = t === INVOCATION_STATES.CREATED || t === INVOCATION_STATES.STARTED;
    return ok
      ? { ok: true }
      : { ok: false, reason: `initial state must be created|started, got ${t}` };
  }
  if (isTerminalInvocationState(f)) {
    return { ok: false, reason: `cannot leave terminal state ${f}` };
  }
  const allowed = INVOCATION_TRANSITIONS[f];
  if (!allowed) {
    return { ok: false, reason: `unknown from state ${f}` };
  }
  if (!allowed.includes(t)) {
    return { ok: false, reason: `transition ${f} → ${t} not allowed` };
  }
  return { ok: true };
}

// ── A2A handoff closed-loop ─────────────────────────────────────────────────

/** Status enums for handoff pipeline stages. */
const HANDOFF_PARSE_STATUS = Object.freeze({
  PARSED: "parsed",
  FAILED: "failed",
  SKIPPED: "skipped",
});

const HANDOFF_ROUTE_STATUS = Object.freeze({
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  DUPLICATE: "duplicate",
  ALREADY_COMPLETED: "already_completed",
});

const HANDOFF_COMPLETE_STATUS = Object.freeze({
  PENDING: "pending",
  COMPLETED: "completed",
  FAILED: "failed",
  ABORTED: "aborted",
});

/**
 * Shape of one handoff record (documentation + validators).
 * All fields listed; implementers may omit optional keys until filled.
 */
const HANDOFF_RECORD_KEYS = Object.freeze([
  "handoffId",
  "sourceAgent",
  "targetAgent",
  "sourceInvocationId",
  "targetInvocationId",
  "reason",
  "depth",
  "parseStatus",
  "routeStatus",
  "receiveStatus",
  "completeStatus",
  "contentHash",
  "duplicateOf",
  "goal",
  "phaseId",
]);

/**
 * Effective A2A hop: accepted route and target completed with both invocation ids.
 * @param {object|null|undefined} record
 */
function isEffectiveA2aHop(record) {
  if (!record || typeof record !== "object") return false;
  if (record.routeStatus !== HANDOFF_ROUTE_STATUS.ACCEPTED) return false;
  if (record.completeStatus !== HANDOFF_COMPLETE_STATUS.COMPLETED) return false;
  if (!record.sourceInvocationId || !record.targetInvocationId) return false;
  if (!record.handoffId) return false;
  return true;
}

// ── Memory funnel ───────────────────────────────────────────────────────────

const MEMORY_FUNNEL_LAYERS = Object.freeze([
  "retrieved",
  "ranked",
  "selected",
  "rendered",
  "delivered",
  "used",
  "correct",
]);

/** Known drop reasons for selected-but-not-rendered (or similar) items. */
const MEMORY_DROP_REASONS = Object.freeze({
  BUCKET_BUDGET: "bucket_budget",
  TOPIC_DEDUP: "topic_dedup",
  SUPERSEDED: "superseded",
  CONFLICT: "conflict",
  ENCODING: "encoding",
  OTHER: "other",
});

/**
 * Stats object attached to memory-inject / metrics (phase 4 fills numbers).
 * used/correct may stay null until citation tracking exists.
 */
const MEMORY_FUNNEL_STATS_KEYS = Object.freeze([
  "retrieved",
  "ranked",
  "selected",
  "rendered",
  "delivered",
  "used",
  "correct",
  "dropped",
  "dropReason",
  "truncated",
]);

// ── Collab task + phase allowlist ───────────────────────────────────────────

const COLLAB_TASK_STATES = Object.freeze(["discuss", "implement", "review", "deliver", "done"]);

/** Machine-readable A2A intents. Phase and intent are deliberately separate. */
const HANDOFF_INTENTS = Object.freeze([
  "discuss",
  "plan",
  "implement",
  "review",
  "fix",
  "deliver",
  "accept",
  "recall",
]);

/** ADR-007 invocation-scoped duties. Kept equal to handoff intents deliberately. */
const DUTIES = Object.freeze([...HANDOFF_INTENTS]);

const ROUTING_REASONS = Object.freeze([
  "explicit_mention",
  "handoff_to",
  "sticky",
  "affinity",
  "solo_fallback",
]);

const ENFORCEMENT_LEVELS = Object.freeze(["enforced", "advisory", "unavailable"]);
const TASK_STATUSES = Object.freeze(["active", "waiting_human", "accepted", "rejected"]);
const EVIDENCE_PROFILES = Object.freeze(["code_change", "working_tree_change", "analysis"]);
const COLLAB_ACTOR_KINDS = Object.freeze(["human", "seat", "system"]);

/**
 * Default phase → allowed agent ids (phase 5 enforces; live multi uses these names).
 * Empty list means "no default restriction documented here".
 */
const DEFAULT_PHASE_AGENT_ALLOWLIST = Object.freeze({
  discuss: Object.freeze(["gemini", "codex", "grok", "opencode"]),
  implement: Object.freeze(["grok"]),
  review: Object.freeze(["opencode"]),
  // OpenCode packages an approved diff; Codex performs outcome acceptance.
  deliver: Object.freeze(["opencode", "codex"]),
  recall: Object.freeze(["codex", "gemini", "grok", "opencode"]),
});

// ── Live report schemas ─────────────────────────────────────────────────────

const REPORT_SCHEMAS = Object.freeze({
  common: Object.freeze([
    "scenarioId",
    "mode",
    "sessionId",
    "exitCode",
    "runKind",
    "durationMs",
    "cleanRunPassed",
    "turnCount",
  ]),
  multiAgent: Object.freeze([
    "phases",
    "invocationMatrix",
    "handoffClosedLoop",
    "duplicateRouteCount",
    "orphanInvocationCount",
    "memoryFunnel",
    "conflictMemoryCount",
    "sealRecovery",
    "costSummary",
  ]),
  memory: Object.freeze([
    "productActiveCount",
    "funnel",
    "staleHitRate",
    "contradictionRate",
    "duplicateTopicRate",
    "searchFallbackRate",
    "writeSuccessRate",
  ]),
  worktree: Object.freeze(["requested", "workspaceKey", "worktreePath", "verified"]),
  performance: Object.freeze([
    "durationMs",
    "phaseDurations",
    "tokenUsage",
    "degraded",
    "degradedReasons",
  ]),
});

/**
 * Validate that required keys exist (value may be null placeholder).
 * @param {string} kind - common | multiAgent | memory | worktree | performance
 * @param {object} obj
 * @returns {{ ok: boolean, missing: string[], unknownKind?: boolean }}
 */
function validateReport(kind, obj) {
  const keys = REPORT_SCHEMAS[kind];
  if (!keys) {
    return { ok: false, missing: [], unknownKind: true };
  }
  if (!obj || typeof obj !== "object") {
    return { ok: false, missing: [...keys] };
  }
  const missing = keys.filter((k) => !Object.prototype.hasOwnProperty.call(obj, k));
  return { ok: missing.length === 0, missing };
}

/**
 * Merge partial report sections; does not fill defaults (callers may set null).
 * @param {object} sections - { common?, multiAgent?, memory?, worktree?, performance? }
 */
function validateReportBundle(sections = {}) {
  const results = {};
  let ok = true;
  for (const kind of Object.keys(REPORT_SCHEMAS)) {
    if (!Object.prototype.hasOwnProperty.call(sections, kind)) {
      results[kind] = { ok: false, missing: [...REPORT_SCHEMAS[kind]], absent: true };
      ok = false;
      continue;
    }
    results[kind] = validateReport(kind, sections[kind]);
    if (!results[kind].ok) ok = false;
  }
  return { ok, results };
}

module.exports = {
  INVOCATION_STATES,
  TERMINAL_INVOCATION_STATES,
  LEGACY_DB_INVOCATION_STATES,
  INVOCATION_TRANSITIONS,
  toDbInvocationState,
  fromDbInvocationState,
  isTerminalInvocationState,
  assertValidTransition,
  HANDOFF_PARSE_STATUS,
  HANDOFF_ROUTE_STATUS,
  HANDOFF_COMPLETE_STATUS,
  HANDOFF_RECORD_KEYS,
  isEffectiveA2aHop,
  MEMORY_FUNNEL_LAYERS,
  MEMORY_DROP_REASONS,
  MEMORY_FUNNEL_STATS_KEYS,
  COLLAB_TASK_STATES,
  HANDOFF_INTENTS,
  DUTIES,
  ROUTING_REASONS,
  ENFORCEMENT_LEVELS,
  TASK_STATUSES,
  EVIDENCE_PROFILES,
  COLLAB_ACTOR_KINDS,
  DEFAULT_PHASE_AGENT_ALLOWLIST,
  REPORT_SCHEMAS,
  validateReport,
  validateReportBundle,
};

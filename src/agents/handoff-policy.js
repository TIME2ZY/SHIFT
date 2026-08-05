const { ENV } = require("../shared/brand");
const { DEFAULT_PHASE_AGENT_ALLOWLIST } = require("../shared/collab-contracts");
const { REVIEWER_AGENT_IDS, IMPLEMENTER_AGENT_IDS, DELIVERY_AGENT_IDS } = require("./handoff");

const POLICY_MODES = Object.freeze(["soft", "balanced", "strict"]);
const DECISIONS = Object.freeze({
  ALLOW: "allow",
  ALLOW_DEGRADED: "allow_degraded",
  REQUEST_REPAIR: "request_repair",
  REJECT: "reject",
});

const PHASES = Object.freeze(["discuss", "implement", "review", "deliver", "recall"]);

/**
 * Resolve SHIFT_HANDOFF_POLICY. Default balanced (Wave H2).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {"soft"|"balanced"|"strict"}
 */
function resolveHandoffPolicyMode(env = process.env) {
  const raw = String(env[ENV.HANDOFF_POLICY] || "")
    .trim()
    .toLowerCase();
  if (POLICY_MODES.includes(raw)) return raw;
  return "balanced";
}

/**
 * Resolve collaboration phase for route policy.
 * explicit phaseId > intent/reviewer target > worktree > discuss.
 */
function resolveCollabPhase(input = {}) {
  const explicit = String(input.phaseId || input.phase || "")
    .trim()
    .toLowerCase();
  if (PHASES.includes(explicit)) return explicit;

  const intent = String(input.intent || input.quality?.intent || "")
    .trim()
    .toLowerCase();
  const to = String(input.toAgent || input.routedTo || "")
    .trim()
    .toLowerCase();
  const from = String(input.fromAgent || "")
    .trim()
    .toLowerCase();

  if (intent === "accept" || intent === "deliver") return "deliver";
  if (intent === "review") return "review";
  if (intent === "discuss") return "discuss";
  if (intent === "recall") return "recall";
  if (intent === "fix") return "implement";
  if (intent === "plan" || intent === "implement") return "implement";
  if (REVIEWER_AGENT_IDS.has(to)) return "review";
  if (REVIEWER_AGENT_IDS.has(from) && IMPLEMENTER_AGENT_IDS.has(to)) {
    return "implement";
  }
  // Worktree / explicit implement intent → implement phase.
  // Merely targeting an implementer without worktree stays "discuss" so
  // discuss_blocks_implementer can fire (prevents discuss→grok implement leak).
  if (input.useWorktree) return "implement";
  return "discuss";
}

/**
 * Phase agent allowlist check (platform constraint, not prompt-only).
 * @returns {{ ok: boolean, phase: string, reason?: string, allowed?: string[] }}
 */
function evaluatePhaseRoute(input = {}) {
  const phase = resolveCollabPhase(input);
  const allowlist = input.allowlist || DEFAULT_PHASE_AGENT_ALLOWLIST;
  const allowed = Array.isArray(allowlist[phase]) ? allowlist[phase] : [];
  const to = String(input.toAgent || input.routedTo || "")
    .trim()
    .toLowerCase();
  const from = String(input.fromAgent || "")
    .trim()
    .toLowerCase();

  if (!to) {
    return { ok: false, phase, reason: "missing_target", allowed: [...allowed] };
  }

  // discuss: do not route to implementers (avoids discuss→grok implement leak)
  if (phase === "discuss" && IMPLEMENTER_AGENT_IDS.has(to)) {
    return {
      ok: false,
      phase,
      reason: "discuss_blocks_implementer",
      allowed: [...allowed],
    };
  }

  if (phase === "discuss" && DELIVERY_AGENT_IDS.has(to)) {
    return {
      ok: false,
      phase,
      reason: "discuss_blocks_delivery",
      allowed: [...allowed],
    };
  }

  // discuss: reviewers optional; default allowlist is gemini/codex
  if (allowed.length > 0 && !allowed.includes(to)) {
    // implement phase may still hand to reviewer even if allowlist is implement-only
    if (phase === "implement" && REVIEWER_AGENT_IDS.has(to)) {
      return { ok: true, phase: "review", reason: null, allowed: [...(allowlist.review || [])] };
    }
    return {
      ok: false,
      phase,
      reason: "target_not_in_phase_allowlist",
      allowed: [...allowed],
    };
  }

  // review phase: target should be reviewer; implementer only for fix intent
  if (phase === "review" && IMPLEMENTER_AGENT_IDS.has(to) && input.intent !== "fix") {
    // allow fix handoff from reviewer → implementer
    if (!(REVIEWER_AGENT_IDS.has(from) && input.intent === "fix")) {
      // still ok if intent fix inferred later; soft check only when clearly wrong
    }
  }

  // non-worktree implement intent toward implementer: degraded/reject at decidePolicy
  if (
    phase === "implement" &&
    !input.useWorktree &&
    IMPLEMENTER_AGENT_IDS.has(to) &&
    input.intent === "implement"
  ) {
    return {
      ok: false,
      phase,
      reason: "implement_requires_worktree",
      allowed: [...allowed],
    };
  }

  return { ok: true, phase, reason: null, allowed: [...allowed] };
}

/**
 * Decide whether an A2A route may enqueue.
 *
 * @param {object} input
 * @param {{ hasBlock?: boolean, ok?: boolean, emptyPacket?: boolean, intent?: string|null }} input.quality
 * @param {boolean} [input.useWorktree]
 * @param {"soft"|"balanced"|"strict"} [input.mode]
 * @param {string} [input.fromAgent]
 * @param {string} [input.toAgent]
 * @param {string} [input.phaseId]
 * @param {{ skip?: boolean, reason?: string }} [input.taskSkip] collab-task-registry result
 * @returns {"allow"|"allow_degraded"|"request_repair"|"reject"}
 */
function decidePolicy(input = {}) {
  const quality = input.quality || {};
  const useWorktree = Boolean(input.useWorktree);
  const mode = POLICY_MODES.includes(input.mode) ? input.mode : resolveHandoffPolicyMode();
  const hasBlock = Boolean(quality.hasBlock) && !quality.emptyPacket;
  const ok = Boolean(quality.ok) && hasBlock;

  // Task-level skip (already approved same evidence)
  if (input.taskSkip && input.taskSkip.skip) {
    return DECISIONS.REJECT;
  }

  // Phase allowlist / boundary — only when a target agent is known (A2A routes).
  // Legacy callers that only pass quality+mode keep prior fence-only behavior.
  const toAgent = input.toAgent || input.routedTo || null;
  if (toAgent) {
    const phaseCheck = evaluatePhaseRoute({
      ...input,
      intent: input.intent || quality.intent,
      toAgent,
      fromAgent: input.fromAgent,
      useWorktree,
    });
    input._phaseCheck = phaseCheck;
    if (!phaseCheck.ok) {
      if (mode === "soft") {
        // Soft: discuss→implementer becomes degraded route (still visible) except hard worktree require
        if (phaseCheck.reason === "implement_requires_worktree") {
          return DECISIONS.REJECT;
        }
        if (
          phaseCheck.reason === "discuss_blocks_implementer" ||
          phaseCheck.reason === "discuss_blocks_delivery"
        ) {
          return DECISIONS.ALLOW_DEGRADED;
        }
        // not in allowlist: soft still degrades rather than hard reject
        return DECISIONS.ALLOW_DEGRADED;
      }
      // balanced/strict: hard reject phase violations
      return DECISIONS.REJECT;
    }
  } else {
    input._phaseCheck = null;
  }

  if (mode === "soft") {
    return ok ? DECISIONS.ALLOW : DECISIONS.ALLOW_DEGRADED;
  }

  if (mode === "strict") {
    return ok ? DECISIONS.ALLOW : DECISIONS.REQUEST_REPAIR;
  }

  // balanced (default)
  if (ok) return DECISIONS.ALLOW;
  if (!hasBlock) {
    // Worktree / write mode: missing fence must not silently continue.
    return useWorktree ? DECISIONS.REQUEST_REPAIR : DECISIONS.ALLOW_DEGRADED;
  }
  // hasBlock but incomplete required fields
  return DECISIONS.ALLOW_DEGRADED;
}

/**
 * Payload when phase/task rejects a route.
 */
function buildPhaseRejectPayload({ fromAgent, toAgent, phaseCheck, taskSkip, mode } = {}) {
  const reason =
    (taskSkip && taskSkip.skip && taskSkip.reason) ||
    (phaseCheck && phaseCheck.reason) ||
    "phase_rejected";
  const phase = phaseCheck?.phase || "?";
  const allowed = phaseCheck?.allowed || [];
  const message = [
    `⛔ 协作阶段/任务策略拒绝路由（policy=${mode || resolveHandoffPolicyMode()}）`,
    `${fromAgent || "?"} → ${toAgent || "?"} phase=${phase} reason=${reason}`,
    allowed.length ? `本阶段允许: ${allowed.map((a) => "@" + a).join(", ")}` : "",
    taskSkip?.state ? `任务状态: ${taskSkip.state}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    from: fromAgent || null,
    to: toAgent || null,
    reason,
    phase,
    allowed,
    taskState: taskSkip?.state || null,
    policy: DECISIONS.REJECT,
    mode: mode || resolveHandoffPolicyMode(),
    message,
  };
}

function canEnqueue(decision) {
  return decision === DECISIONS.ALLOW || decision === DECISIONS.ALLOW_DEGRADED;
}

/**
 * Human-readable system/SSE payload for request_repair.
 */
function buildRepairPayload({ fromAgent, toAgent, quality, mode } = {}) {
  const missing =
    quality && Array.isArray(quality.missing) && quality.missing.length > 0
      ? quality.missing.join(", ")
      : "what, why, next_action";
  const empty = !quality || quality.emptyPacket || !quality.hasBlock;
  const example = [
    "```handoff",
    `to: ${toAgent || "<agent>"}`,
    "intent: <discuss|plan|implement|review|fix|deliver|accept|recall>",
    "goal: <可空>",
    "what: <尽量填>",
    "why: <尽量填>",
    "next_action: <尽量填>",
    "files:",
    "  - <可空>",
    "```",
  ].join("\n");

  const reason = empty ? "缺少标准 ```handoff 块" : `handoff 不完整（缺失: ${missing}）`;

  const message = [
    `⛔ 交接需补全后再 @（policy=${mode || resolveHandoffPolicyMode()}）`,
    `${fromAgent || "?"} → ${toAgent || "?"}: ${reason}`,
    "本轮未入队。请补全 handoff 后重新行首 @ 目标。",
    "",
    "示例：",
    example,
  ].join("\n");

  return {
    from: fromAgent || null,
    to: toAgent || null,
    reason: empty ? "missing_handoff" : "incomplete_handoff",
    missing: quality && Array.isArray(quality.missing) ? quality.missing.slice() : [],
    emptyPacket: Boolean(empty),
    policy: DECISIONS.REQUEST_REPAIR,
    mode: mode || resolveHandoffPolicyMode(),
    message,
    example,
  };
}

module.exports = {
  POLICY_MODES,
  DECISIONS,
  PHASES,
  resolveHandoffPolicyMode,
  resolveCollabPhase,
  evaluatePhaseRoute,
  decidePolicy,
  canEnqueue,
  buildRepairPayload,
  buildPhaseRejectPayload,
};

const { ENV } = require("../shared/brand");

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
 * explicit phaseId > intent > worktree > discuss.
 */
function resolveCollabPhase(input = {}) {
  const explicit = String(input.phaseId || input.phase || "")
    .trim()
    .toLowerCase();
  if (PHASES.includes(explicit)) return explicit;

  const intent = String(input.intent || input.quality?.intent || "")
    .trim()
    .toLowerCase();
  if (intent === "accept" || intent === "deliver") return "deliver";
  if (intent === "review") return "review";
  if (intent === "discuss") return "discuss";
  if (intent === "recall") return "recall";
  if (intent === "fix" || intent === "implement") return "implement";
  if (intent === "plan") return "implement";
  if (input.useWorktree) return "implement";
  return "discuss";
}

/**
 * Enabled Seat and phase-boundary check.
 * @returns {{ ok: boolean, phase: string, reason?: string, allowed?: string[] }}
 */
function evaluatePhaseRoute(input = {}) {
  const phase = resolveCollabPhase(input);
  const enabledSeats = Array.isArray(input.enabledSeats) ? input.enabledSeats : [];
  const allowed = enabledSeats
    .filter((seat) => seat && seat.enabled !== false)
    .map((seat) => seat.providerId || seat.seatId)
    .filter(Boolean);
  const intent = String(input.intent || input.quality?.intent || "")
    .trim()
    .toLowerCase();
  const to = String(input.toAgent || input.routedTo || "")
    .trim()
    .toLowerCase();

  if (!to) {
    return { ok: false, phase, reason: "missing_target", allowed: [...allowed] };
  }

  if (!input.targetSeat || input.targetSeat.enabled === false) {
    return {
      ok: false,
      phase,
      intent,
      reason: "target_seat_not_enabled",
      allowed: [...allowed],
    };
  }

  if (phase === "implement" && !input.useWorktree && intent === "implement") {
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
  const isContractValid =
    Boolean(quality.ok) &&
    hasBlock &&
    !quality.toMismatch &&
    !quality.invalidIntent &&
    !quality.riskFlags?.includes("invalid_intent");

  // Task-level skip (already approved same evidence)
  if (input.taskSkip && input.taskSkip.skip) {
    return DECISIONS.REJECT;
  }

  // Enabled Seat / phase boundary — only when a target agent is known (A2A routes).
  // Legacy callers that only pass quality+mode keep prior fence-only behavior.
  const toAgent = input.toAgent || input.routedTo || null;
  if (toAgent) {
    const phaseCheck = evaluatePhaseRoute({
      ...input,
      intent: input.intent || quality.intent,
      toAgent,
      fromAgent: input.fromAgent,
      useWorktree,
      targetSeat: input.targetSeat,
      enabledSeats: input.enabledSeats,
    });
    input._phaseCheck = phaseCheck;
    if (!phaseCheck.ok) {
      if (mode === "soft" && phaseCheck.reason !== "implement_requires_worktree") {
        if (phaseCheck.reason === "target_seat_not_enabled") return DECISIONS.REJECT;
        return DECISIONS.ALLOW_DEGRADED;
      }
      return DECISIONS.REJECT;
    }
  } else {
    input._phaseCheck = null;
  }

  if (mode === "soft") {
    return isContractValid ? DECISIONS.ALLOW : DECISIONS.ALLOW_DEGRADED;
  }

  if (mode === "strict") {
    return isContractValid ? DECISIONS.ALLOW : DECISIONS.REQUEST_REPAIR;
  }

  // balanced (default): strict contract validation - incomplete blocks or semantic drift request repair
  if (isContractValid) return DECISIONS.ALLOW;
  if (!hasBlock) {
    const isDiscussion = !useWorktree && (!quality.intent || quality.intent === "discuss");
    return isDiscussion ? DECISIONS.ALLOW_DEGRADED : DECISIONS.REQUEST_REPAIR;
  }
  return DECISIONS.REQUEST_REPAIR;
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
    allowed.length ? `当前 Thread 可路由席位: ${allowed.map((a) => "@" + a).join(", ")}` : "",
    taskSkip?.message || "",
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
      : "";
  const empty = !quality || quality.emptyPacket || !quality.hasBlock;
  const example = [
    "```handoff",
    `to: ${toAgent || "<agent>"}`,
    "intent: <discuss|plan|implement|review|fix|deliver|accept|recall>",
    "goal: <用户目标与范围>",
    "what: |",
    "  已完成: <做了什么>",
    "  做到哪: <当前停点>",
    "why: <为何交；约束>",
    "next_action: <唯一下一步>",
    "files:",
    "  - path — 为何重要",
    "evidence:",
    "  - 失败或验证",
    "```",
  ].join("\n");

  let reason = empty ? "缺少标准 ```handoff 块" : "handoff 契约不满足";
  let reasonCode = empty ? "missing_handoff" : "incomplete_handoff";
  if (quality?.toMismatch) {
    reason = `handoff.to 与 @ 目标 (${toAgent || ""}) 不一致`;
    reasonCode = "to_mismatch";
  } else if (quality?.riskFlags?.includes("invalid_intent")) {
    reason = `intent 非法: ${quality.intent || ""}`;
    reasonCode = "invalid_intent";
  } else if (missing) {
    reason = `handoff 不完整（缺失: ${missing}）`;
    reasonCode = "incomplete_handoff";
  }

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
    reason: reasonCode,
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

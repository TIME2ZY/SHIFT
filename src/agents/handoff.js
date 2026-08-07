/**
 * Structured A2A handoff packets — render / receive-bundle / policy banner.
 *
 * Phase C-3 boundary:
 * - parse + evaluate: ./handoff-parse.js
 * - route finalize: ./a2a-finalize.js
 * - hop registry: ./handoff-route-registry.js (via a2a-finalize wrappers)
 *
 * Agents should emit a fenced ```handoff block when routing to another agent.
 * Soft mode (default): missing fields still allow routing; the next agent is
 * told the handoff is degraded. Hard blocking is intentionally not enabled yet.
 */

const {
  REQUIRED_FIELDS,
  RECOMMENDED_FIELDS,
  parseHandoffBlocks,
  parseHandoffBody,
  extractPrimaryHandoff,
  extractPrimaryHandoffMatch,
  selectCanonicalHandoffMatch,
  evaluateHandoff,
  computeToMismatch,
  inferIntent,
  normalizeIntent,
  normalizeTo,
  toMatchesRoute,
  hasValue,
} = require("./handoff-parse");
const {
  WORKFLOW_ROLES,
  agentsWithCapability,
  agentIdsForRole,
} = require("./role-contracts");


const DEFAULT_APPENDIX_CHARS = 5000;
/** No handoff fence: even more of the prior text is the only payload. */
const DEGRADED_APPENDIX_CHARS = 8000;
/** Wave H1 controlled appendix budgets (handoff-design §6.3). */
const APPENDIX_OK_FULL = 2000;
const APPENDIX_OK_THIN = 4000;
const APPENDIX_OK_DEFAULT = 3000;
const APPENDIX_DEGRADED = 5000;
const APPENDIX_EMPTY = 7000;
/** User prompt window inside Receive Bundle. */
const USER_PROMPT_MAX_CHARS = 2000;

/** Prefer keeping windows that contain these review/handoff anchors. */
const APPENDIX_ANCHORS = [
  "request-changes",
  "approve-with-nits",
  "```handoff",
  "结论:",
  "结论：",
  "P0",
  "P1",
  "## Review",
  "## 评审",
  "### P0",
  "### P1",
];

const IMPLEMENTER_AGENT_IDS = new Set(agentIdsForRole(WORKFLOW_ROLES.IMPLEMENTER));
const REVIEWER_AGENT_IDS = new Set(agentsWithCapability("review"));
const LEAD_AGENT_IDS = new Set(agentIdsForRole(WORKFLOW_ROLES.LEAD));
const DISCUSSION_AGENT_IDS = new Set(agentsWithCapability("discuss"));
const DELIVERY_AGENT_IDS = new Set(agentsWithCapability("deliver"));

/**
 * @typedef {object} Handoff
 * @property {string} [to]
 * @property {string} [intent]
 * @property {string} [goal]
 * @property {string} [what]
 * @property {string} [why]
 * @property {string} [tradeoff]
 * @property {string} [next_action]
 * @property {string[]} [open_questions]
 * @property {string[]} [files]
 * @property {string[]} [evidence]
 * @property {string} raw
 */

/**
 * @typedef {object} HandoffQuality
 * @property {boolean} ok
 * @property {boolean} degraded
 * @property {string[]} missing
 * @property {string[]} missingRecommended
 * @property {number} score
 * @property {boolean} hasBlock
 * @property {boolean} emptyPacket
 * @property {boolean} toMismatch
 * @property {string[]} repairHints
 * @property {string[]} riskFlags
 * @property {string|null} intent
 * @property {string|null} [policy] Wave H2 placeholder (soft/allow/…); H0 leaves null
 */

/**
 * Extract all ```handoff ... ``` blocks from agent output.
 * @param {string} text
 * @returns {Handoff[]}
 */
/**
 * Compact handoff reminder for A2A turns (avoids re-injecting the full
 * always-on a2a-handoff skill body — collaboration rules already cover basics).
 * @returns {string}
 */
function renderA2AHandoffCard() {
  return `<!-- A2A Handoff Card -->
## 共用 handoff 提醒（精简）

出站交接：行首 \`@队友\` + 同一套 fence；**可选字段可空**；禁止 \`verdict\`/\`nits\`/\`blocking\` 等私有顶层 key。

\`\`\`handoff
to: <agent>
intent: <discuss|plan|implement|review|fix|deliver|accept|recall>
goal: <可空>
what: <尽量填：交什么 / 审什么 / 结论: approve|approve-with-nits|request-changes + 分级列表>
why: <尽量填>
tradeoff: <可空>
next_action: <尽量填：希望对方立刻做什么>
open_questions:  # 可空
files:           # 可空
evidence:        # 可空
\`\`\`

入站：优先执行 Structured Handoff；缺项先补上下文，勿表演性附和。
<!-- /A2A Handoff Card -->`;
}

/**
 * Pick an appendix window: prefer the tail, but if review/handoff anchors would
 * be cut off, start near the earliest anchor so P0/结论 stay visible.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function selectAppendix(text, maxChars) {
  const s = String(text || "");
  const limit = Math.max(0, Number(maxChars) || 0);
  if (!s || limit === 0) return "";
  if (s.length <= limit) return s.trim();

  let earliestAnchor = -1;
  for (const marker of APPENDIX_ANCHORS) {
    const idx = s.indexOf(marker);
    if (idx >= 0 && (earliestAnchor < 0 || idx < earliestAnchor)) {
      earliestAnchor = idx;
    }
  }

  const tailStart = s.length - limit;
  if (earliestAnchor >= 0 && earliestAnchor < tailStart) {
    const start = Math.max(0, earliestAnchor - 80);
    return s.slice(start, start + limit).trim();
  }
  return s.slice(tailStart).trim();
}

/**
 * Whether the A2A target should receive the receiving-review skill.
 * Implementers fixing after a reviewer (or review-shaped handoff) need it.
 *
 * @param {{ targetAgentId?: string, fromAgentId?: string, handoff?: Handoff | null, text?: string }} opts
 * @returns {boolean}
 */
function shouldInjectReceivingReview(opts = {}) {
  const target = String(opts.targetAgentId || "")
    .trim()
    .toLowerCase();
  if (!IMPLEMENTER_AGENT_IDS.has(target)) return false;

  const from = String(opts.fromAgentId || "")
    .trim()
    .toLowerCase();
  if (REVIEWER_AGENT_IDS.has(from)) return true;

  const quality = opts.quality || null;
  if (quality && (quality.intent === "fix" || quality.degraded || quality.emptyPacket)) {
    return true;
  }

  const handoff = opts.handoff || null;
  const blob = [
    handoff && handoff.what,
    handoff && handoff.why,
    handoff && handoff.next_action,
    handoff && handoff.goal,
    opts.text,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  return /request-changes|approve-with-nits|\bp0\b|\bp1\b|review\s*意见|修改意见|请修|fix these|blocking/.test(
    blob
  );
}

/**
 * Controlled appendix budget for Receive Bundle (Wave H1).
 * @param {HandoffQuality | null | undefined} quality
 * @param {Handoff | null | undefined} handoff
 * @param {{ hasMemoryCard?: boolean }} [options]
 * @returns {number}
 */
function resolveAppendixChars(quality, handoff, options = {}) {
  let limit;
  if (!quality || quality.emptyPacket || !quality.hasBlock) {
    limit = APPENDIX_EMPTY;
  } else if (quality.degraded || !quality.ok) {
    limit = APPENDIX_DEGRADED;
  } else {
    const hasFiles = Array.isArray(handoff?.files) && handoff.files.length > 0;
    const hasNext = hasValue(handoff?.next_action);
    if (hasFiles && hasNext) {
      limit = APPENDIX_OK_FULL;
    } else if (quality.intent === "review" || quality.intent === "fix") {
      limit = APPENDIX_OK_THIN;
    } else {
      limit = APPENDIX_OK_DEFAULT;
    }
  }
  if (options.hasMemoryCard) {
    limit = Math.max(1000, Math.floor(limit * 0.7));
  }
  return limit;
}

function truncateUserPrompt(value, maxChars = USER_PROMPT_MAX_CHARS) {
  const text = typeof value === "string" ? value : "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * Policy / quality banner for the receiving agent (Wave H1).
 * @param {HandoffQuality | null | undefined} quality
 * @returns {string}
 */
function renderPolicyBanner(quality) {
  if (!quality) return "";
  const lines = [];
  if (quality.emptyPacket || !quality.hasBlock) {
    lines.push(
      "⚠ emptyPacket：无标准 handoff。请先 session-search / 读 Active Memories，再执行破坏性操作。"
    );
  } else if (quality.degraded || !quality.ok) {
    lines.push(
      `⚠ degraded：交接包不完整（缺失: ${
        (quality.missing && quality.missing.join(", ")) || "—"
      }）。先补上下文再改代码。`
    );
  }
  if (quality.toMismatch) {
    lines.push("⚠ toMismatch：路由目标以行首 @（to_routed）为准，忽略冲突的 packet.to。");
  }
  if (quality.policy === "request_repair") {
    lines.push("⛔ request_repair：本轮未入队；请发送方补全 handoff 后再 @。");
  } else if (quality.policy === "allow_degraded") {
    lines.push("ℹ policy=allow_degraded：已放行，但交接质量不足。");
  }
  if (lines.length === 0) return "";
  return ["<!-- Policy Banner -->", ...lines, "<!-- /Policy Banner -->"].join("\n");
}

/**
 * Assemble A2A Receive Bundle middle section (identity/collab/callback stay outside).
 *
 * Order: Memory Card → Policy Banner → Structured Handoff Task → outbound A2A card.
 *
 * @param {object} opts
 * @returns {{ text: string, appendixChars: number, hasMemoryCard: boolean, policyBanner: string }}
 */
function renderReceiveBundle(opts = {}) {
  const memoryCard = typeof opts.memoryCard === "string" ? opts.memoryCard.trim() : "";
  const hasMemoryCard = Boolean(memoryCard) && !/Active Memories\s*\(0\)/.test(memoryCard);
  const handoff = opts.handoff || null;
  const quality =
    opts.quality ||
    evaluateHandoff(handoff, {
      routedTo: opts.toAgentId,
      fromAgentId: opts.fromAgent,
      toAgentId: opts.toAgentId,
    });
  const appendixChars =
    opts.appendixChars !== undefined
      ? opts.appendixChars
      : resolveAppendixChars(quality, handoff, { hasMemoryCard });
  const policyBanner = renderPolicyBanner(quality);
  const task = renderHandoffTask({
    ...opts,
    handoff,
    quality,
    appendixChars,
    userPrompt: truncateUserPrompt(opts.userPrompt || ""),
  });
  const parts = ["<!-- Receive Bundle -->"];
  if (memoryCard) parts.push(memoryCard);
  if (policyBanner) parts.push(policyBanner);
  parts.push(task);
  if (opts.includeOutboundCard !== false) {
    parts.push(renderA2AHandoffCard());
  }
  parts.push("<!-- /Receive Bundle -->");
  return {
    text: parts.filter(Boolean).join("\n\n"),
    appendixChars,
    hasMemoryCard,
    policyBanner,
  };
}

/**
 * Render the task body for the next agent from a structured handoff.
 *
 * @param {object} opts
 * @param {Handoff | null} opts.handoff
 * @param {HandoffQuality} [opts.quality]
 * @param {string} opts.fromAgent
 * @param {string} [opts.fromLabel]
 * @param {string} [opts.toAgentId] routed @ target (authoritative)
 * @param {string} [opts.toLabel]
 * @param {string} opts.fromContent
 * @param {string} opts.userPrompt
 * @param {number} [opts.appendixChars]
 * @returns {string}
 */
function renderHandoffTask(opts) {
  const {
    handoff,
    fromAgent,
    fromLabel,
    toAgentId = "",
    toLabel = "",
    fromContent = "",
    userPrompt = "",
  } = opts;
  const quality =
    opts.quality ||
    evaluateHandoff(handoff, {
      routedTo: toAgentId,
      fromAgentId: fromAgent,
      toAgentId,
    });
  const hasMemoryCard = Boolean(opts.hasMemoryCard);
  const appendixChars =
    opts.appendixChars !== undefined
      ? opts.appendixChars
      : resolveAppendixChars(quality, handoff, { hasMemoryCard });
  const userPromptWindow = truncateUserPrompt(userPrompt);

  const label = fromLabel || fromAgent || "previous agent";
  const routed = String(toAgentId || "").trim();
  const routedLabel = toLabel || routed;

  if (!handoff || !quality.hasBlock) {
    return renderDegradedHandoff({
      fromAgent,
      fromLabel: label,
      toAgentId: routed,
      toLabel: routedLabel,
      fromContent,
      userPrompt: userPromptWindow,
      missing: quality.missing,
      repairHints: quality.repairHints,
      appendixChars: Math.max(appendixChars, APPENDIX_EMPTY),
    });
  }

  const lines = [`[任务交接：由 ${label} 转交给你]`, "", "<!-- Structured Handoff -->"];

  if (routed) {
    lines.push(
      `to_routed: ${routed}${routedLabel && routedLabel !== routed ? ` (${routedLabel})` : ""}`
    );
  }
  if (hasValue(handoff.to)) {
    lines.push(`to_packet: ${handoff.to}`);
  }
  if (
    quality.toMismatch ||
    (routed && hasValue(handoff.to) && computeToMismatch(handoff, routed))
  ) {
    lines.push("⚠ 路由目标以行首 @ 为准；packet.to 与路由不一致时，以 to_routed 为准。");
  }

  if (quality.emptyPacket) {
    lines.push("交接包完整度: emptyPacket", "");
  } else if (quality.degraded || !quality.ok) {
    lines.push(
      `⚠ 交接包不完整（缺失必填: ${quality.missing.join(", ") || "—"}）。请先补全上下文，谨慎执行破坏性操作。`,
      ""
    );
  } else {
    lines.push("交接包完整度: ok", "");
  }

  if (quality.intent) lines.push(`intent: ${quality.intent}`);
  pushField(lines, "goal", handoff.goal);
  pushField(lines, "next_action", handoff.next_action);
  pushField(lines, "what", handoff.what);
  pushField(lines, "why", handoff.why);
  pushField(lines, "tradeoff", handoff.tradeoff);
  pushList(lines, "files", handoff.files);
  pushList(lines, "evidence", handoff.evidence);
  pushList(lines, "open_questions", handoff.open_questions);
  if (Array.isArray(quality.repairHints) && quality.repairHints.length > 0) {
    lines.push("repair_hints:");
    for (const hint of quality.repairHints) lines.push(`  - ${hint}`);
  }
  lines.push("<!-- /Structured Handoff -->", "");

  lines.push("=== 用户原始请求 ===", userPromptWindow || "(无)", "");

  const appendix = selectAppendix(fromContent, appendixChars);
  if (appendix) {
    lines.push(
      `=== ${label} 原文附录（截断，budget=${appendixChars}） ===`,
      appendix,
      "",
      "请优先依据 Structured Handoff 执行；附录仅供补充。"
    );
  } else {
    lines.push("请根据 Structured Handoff 继续执行任务。");
  }

  return lines.join("\n");
}

/**
 * Fallback when no handoff block is present.
 */
function renderDegradedHandoff(opts) {
  const {
    fromAgent,
    fromLabel,
    toAgentId = "",
    toLabel = "",
    fromContent = "",
    userPrompt = "",
    missing = REQUIRED_FIELDS.slice(),
    repairHints = [],
    appendixChars = DEGRADED_APPENDIX_CHARS,
  } = opts;
  const label = fromLabel || fromAgent || "previous agent";
  const prevBlock = selectAppendix(fromContent, Math.max(appendixChars, APPENDIX_EMPTY));
  const routed = String(toAgentId || "").trim();
  const lines = [
    `[任务交接：由 ${label} 转交给你]`,
    "",
    "⚠ 上一位 Agent 未提供标准 ```handoff 块。以下信息可能不完整。",
    `交接包完整度: emptyPacket`,
  ];
  if (routed) {
    lines.push(
      `to_routed: ${routed}${toLabel && toLabel !== routed ? ` (${toLabel})` : ""}`,
      "⚠ 路由目标以行首 @ 为准。"
    );
  }
  lines.push(
    `缺失: ${missing.join(", ") || "what, why, next_action"}`,
    "请先用 session-search / 读 Active Memories 补全，不要凭猜测执行破坏性操作。"
  );
  if (Array.isArray(repairHints) && repairHints.length > 0) {
    lines.push("repair_hints:");
    for (const hint of repairHints) lines.push(`  - ${hint}`);
  }
  lines.push(
    "",
    `=== ${label} 的完整分析 ===`,
    prevBlock,
    "",
    "=== 用户原始请求 ===",
    userPrompt || "(无)",
    "",
    "请根据上述上下文继续执行任务。"
  );
  return lines.join("\n");
}

function pushField(lines, key, value) {
  if (!hasValue(value)) return;
  lines.push(`${key}: ${value}`);
}

function pushList(lines, key, values) {
  if (!Array.isArray(values) || values.length === 0) return;
  lines.push(`${key}:`);
  for (const item of values) {
    lines.push(`  - ${item}`);
  }
}

/**
 * Summarize quality for SSE / transcript (no large payloads).
 * @param {Handoff | null} handoff
 * @param {HandoffQuality} quality
 */
function summarizeHandoff(handoff, quality) {
  return {
    hasBlock: quality.hasBlock,
    ok: quality.ok,
    degraded: quality.degraded,
    score: quality.score,
    missing: quality.missing.slice(),
    emptyPacket: Boolean(quality.emptyPacket),
    toMismatch: Boolean(quality.toMismatch),
    repairHints: Array.isArray(quality.repairHints) ? quality.repairHints.slice() : [],
    riskFlags: Array.isArray(quality.riskFlags) ? quality.riskFlags.slice() : [],
    intent: quality.intent || null,
    // Wave H2 will fill real policy decisions; H0 exposes the slot for observability.
    policy: quality.policy || null,
    to: handoff && handoff.to ? String(handoff.to) : null,
    next_action: handoff && handoff.next_action ? String(handoff.next_action).slice(0, 200) : null,
  };
}

module.exports = {
  REQUIRED_FIELDS,
  RECOMMENDED_FIELDS,
  DEFAULT_APPENDIX_CHARS,
  DEGRADED_APPENDIX_CHARS,
  APPENDIX_OK_FULL,
  APPENDIX_OK_THIN,
  APPENDIX_OK_DEFAULT,
  APPENDIX_DEGRADED,
  APPENDIX_EMPTY,
  USER_PROMPT_MAX_CHARS,
  IMPLEMENTER_AGENT_IDS,
  REVIEWER_AGENT_IDS,
  LEAD_AGENT_IDS,
  DISCUSSION_AGENT_IDS,
  DELIVERY_AGENT_IDS,
  normalizeIntent,
  parseHandoffBlocks,
  parseHandoffBody,
  extractPrimaryHandoff,
  extractPrimaryHandoffMatch,
  selectCanonicalHandoffMatch,
  evaluateHandoff,
  computeToMismatch,
  inferIntent,
  resolveAppendixChars,
  truncateUserPrompt,
  renderPolicyBanner,
  renderReceiveBundle,
  renderHandoffTask,
  renderDegradedHandoff,
  renderA2AHandoffCard,
  selectAppendix,
  shouldInjectReceivingReview,
  summarizeHandoff,
  normalizeTo,
  toMatchesRoute,
};

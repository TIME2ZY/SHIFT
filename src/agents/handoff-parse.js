/**
 * Handoff fence parsing and field evaluation (Phase C-3).
 * Boundary: parse/evaluate only. Rendering / receive-bundle live in handoff.js.
 * Routing finalize lives in a2a-finalize.js.
 */

const REQUIRED_FIELDS = ["what", "why", "next_action"];
const RECOMMENDED_FIELDS = ["to", "intent", "goal", "tradeoff", "open_questions"];
const LIST_FIELDS = new Set(["open_questions", "files", "evidence"]);
const SCALAR_FIELDS = new Set(["to", "intent", "goal", "what", "why", "tradeoff", "next_action"]);
const ALL_KNOWN_FIELDS = new Set([...SCALAR_FIELDS, ...LIST_FIELDS]);
const { HANDOFF_INTENTS } = require("../shared/collab-contracts");
const { WORKFLOW_ROLES, agentIdsForRole } = require("./role-contracts");

const IMPLEMENTER_AGENT_IDS = new Set(agentIdsForRole(WORKFLOW_ROLES.IMPLEMENTER));
const REVIEWER_AGENT_IDS = new Set(agentIdsForRole(WORKFLOW_ROLES.REVIEWER_DELIVERER));

function parseHandoffBlocks(text) {
  if (!text || typeof text !== "string") return [];

  const blocks = [];
  const re = /```handoff\s*\r?\n([\s\S]*?)```/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    const raw = match[1].trim();
    if (!raw) continue;
    const parsed = parseHandoffBody(raw);
    if (parsed) blocks.push(parsed);
  }
  return blocks;
}

/**
 * Parse the interior of a handoff fence into a structured object.
 * @param {string} body
 * @returns {Handoff | null}
 */
function parseHandoffBody(body) {
  if (!body || typeof body !== "string") return null;

  /** @type {Handoff} */
  const handoff = { raw: body };
  let currentKey = null;
  let currentIsList = false;
  const scalarBuf = Object.create(null);

  const flushScalar = () => {
    if (!currentKey || currentIsList) return;
    const value = (scalarBuf[currentKey] || []).join("\n").trim();
    if (value) handoff[currentKey] = value;
    scalarBuf[currentKey] = [];
  };

  for (const line of body.split(/\r?\n/)) {
    const keyMatch = line.match(/^([a-z_]+)\s*:\s*(.*)$/i);
    if (keyMatch) {
      const key = keyMatch[1].toLowerCase();
      const rest = keyMatch[2];
      if (ALL_KNOWN_FIELDS.has(key)) {
        flushScalar();
        currentKey = key;
        currentIsList = LIST_FIELDS.has(key);

        if (currentIsList) {
          if (!Array.isArray(handoff[key])) handoff[key] = [];
          const item = rest.trim();
          if (item) {
            // Support "files: a.js, b.js" on the same line
            if (item.includes(",") && !item.startsWith("-")) {
              for (const part of item.split(",")) {
                const t = part.trim().replace(/^[-*]\s+/, "");
                if (t) handoff[key].push(t);
              }
            } else {
              handoff[key].push(item.replace(/^[-*]\s+/, ""));
            }
          }
        } else {
          scalarBuf[key] = rest.trim() ? [rest.trim()] : [];
        }
        continue;
      }

      // Unknown key (e.g. review-only verdict/nits): do NOT append to the
      // previous scalar — that polluted `to` and broke routing checks.
      flushScalar();
      currentKey = null;
      currentIsList = false;
      continue;
    }

    // Continuation / list item under current key
    if (!currentKey) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (currentIsList) {
      if (!Array.isArray(handoff[currentKey])) handoff[currentKey] = [];
      if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        handoff[currentKey].push(trimmed.slice(2).trim());
      } else {
        handoff[currentKey].push(trimmed);
      }
    } else {
      if (!scalarBuf[currentKey]) scalarBuf[currentKey] = [];
      scalarBuf[currentKey].push(trimmed);
    }
  }
  flushScalar();

  // `to` is a single agent token — keep first line only if a model wrapped junk.
  if (typeof handoff.to === "string") {
    handoff.to = handoff.to.split(/\r?\n/)[0].trim();
    if (!handoff.to) delete handoff.to;
  }
  if (typeof handoff.intent === "string") {
    handoff.intent = handoff.intent.split(/\r?\n/)[0].trim().toLowerCase();
    if (!handoff.intent) delete handoff.intent;
  }

  // Normalize empty arrays away
  for (const key of LIST_FIELDS) {
    if (Array.isArray(handoff[key]) && handoff[key].length === 0) {
      delete handoff[key];
    }
  }

  // A block with no known fields is not a real handoff
  const hasAny = [...ALL_KNOWN_FIELDS].some((k) => {
    const v = handoff[k];
    return Array.isArray(v) ? v.length > 0 : Boolean(v);
  });
  if (!hasAny) return null;

  return handoff;
}

/**
 * Pick the primary handoff for the next agent.
 * Prefers the last block; if routedTo is set, prefers matching `to`.
 *
 * @param {string} text
 * @param {{ currentAgentId?: string, routedTo?: string, mentionCount?: number, multiTarget?: boolean }} [opts]
 * @returns {Handoff | null}
 */
function extractPrimaryHandoff(text, opts = {}) {
  return extractPrimaryHandoffMatch(text, opts).handoff;
}

/**
 * Pick the primary handoff and retain its parsed block index for stable capture keys.
 *
 * Canonical block rule (phase 3): at most **one** fence is authoritative per route target.
 * Multiple ```handoff blocks with the same/empty `to` collapse to the last match —
 * earlier duplicates are ignored (not multi-route).
 *
 * Per-target selection (Wave H0 / handoff-design §4.2–4.3):
 * 1. Prefer last block whose `to` matches routedTo
 * 2. If multi-@ and no match → null (do not silently share one pack as ok)
 * 3. If single-@ and no match → last unbound (`to` empty) block, else last block
 *
 * @param {string} text
 * @param {{ currentAgentId?: string, routedTo?: string, mentionCount?: number, multiTarget?: boolean }} [opts]
 * @returns {{ handoff: Handoff | null, blockIndex: number | null, blockCount: number, canonical: boolean }}
 */
function extractPrimaryHandoffMatch(text, opts = {}) {
  const blocks = parseHandoffBlocks(text);
  if (blocks.length === 0) {
    return { handoff: null, blockIndex: null, blockCount: 0, canonical: false };
  }

  const routedTo = opts.routedTo ? String(opts.routedTo).toLowerCase() : "";
  const multiTarget = isMultiTarget(opts);

  if (routedTo) {
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (toMatchesRoute(blocks[i].to, routedTo)) {
        return {
          handoff: blocks[i],
          blockIndex: i,
          blockCount: blocks.length,
          canonical: true,
        };
      }
    }
    if (multiTarget) {
      return { handoff: null, blockIndex: null, blockCount: blocks.length, canonical: false };
    }
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (!normalizeTo(blocks[i].to)) {
        return {
          handoff: blocks[i],
          blockIndex: i,
          blockCount: blocks.length,
          canonical: true,
        };
      }
    }
  }

  return {
    handoff: blocks[blocks.length - 1],
    blockIndex: blocks.length - 1,
    blockCount: blocks.length,
    canonical: true,
  };
}

/** Alias: explicit name for phase-3 “one canonical fence per target”. */
function selectCanonicalHandoffMatch(text, opts = {}) {
  return extractPrimaryHandoffMatch(text, opts);
}

function isMultiTarget(opts = {}) {
  if (opts.multiTarget === true) return true;
  if (opts.multiTarget === false) return false;
  const count = Number(opts.mentionCount);
  return Number.isFinite(count) && count > 1;
}

function toMatchesRoute(packetTo, routedTo) {
  const to = normalizeTo(packetTo);
  const target = String(routedTo || "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");
  if (!to || !target) return false;
  return to === target || to.includes(target) || target.includes(to);
}

function normalizeTo(value) {
  if (!value) return "";
  // First line only — models sometimes leak multi-line junk into `to`.
  const firstLine = String(value).split(/\r?\n/)[0].trim();
  return firstLine.replace(/^@/, "").toLowerCase();
}

/**
 * Evaluate completeness of a handoff (soft scoring).
 * @param {Handoff | null} handoff
 * @param {{ routedTo?: string, riskFlags?: string[], intent?: string|null, policy?: string|null, fromAgentId?: string, toAgentId?: string, useWorktree?: boolean }} [opts]
 * @returns {HandoffQuality}
 */
function evaluateHandoff(handoff, opts = {}) {
  const riskFlags = normalizeRiskFlags(opts.riskFlags);
  if (opts.useWorktree && !riskFlags.includes("worktree")) riskFlags.push("worktree");

  if (!handoff) {
    return {
      ok: false,
      degraded: true,
      missing: REQUIRED_FIELDS.slice(),
      missingRecommended: RECOMMENDED_FIELDS.slice(),
      score: 0,
      hasBlock: false,
      emptyPacket: true,
      toMismatch: false,
      repairHints: ["缺少 ```handoff 块。请补充 to/what/why/next_action 后再用行首 @ 交接。"],
      riskFlags,
      intent: inferIntent(null, opts),
      policy: opts.policy || null,
    };
  }

  const missing = REQUIRED_FIELDS.filter((k) => !hasValue(handoff[k]));
  const missingRecommended = RECOMMENDED_FIELDS.filter((k) => !hasValue(handoff[k]));
  const invalidIntent = Boolean(handoff.intent && !normalizeIntent(handoff.intent));
  if (invalidIntent && !missingRecommended.includes("intent")) {
    missingRecommended.push("intent");
    riskFlags.push("invalid_intent");
  }
  const requiredScore = (REQUIRED_FIELDS.length - missing.length) / REQUIRED_FIELDS.length;
  const recommendedScore =
    (RECOMMENDED_FIELDS.length - missingRecommended.length) / RECOMMENDED_FIELDS.length;
  const score = Math.round((requiredScore * 0.75 + recommendedScore * 0.25) * 100) / 100;
  const ok = missing.length === 0;
  const routedTo = opts.routedTo || opts.toAgentId || "";
  const toMismatch = computeToMismatch(handoff, routedTo);
  const repairHints = [];
  if (missing.length > 0) {
    repairHints.push(`补全必填字段: ${missing.join(", ")}`);
  }
  if (toMismatch) {
    repairHints.push("packet.to 与行首 @ 路由目标不一致；接收侧以 @ 为准。");
  }
  if (missingRecommended.includes("to")) {
    repairHints.push("建议填写 to: 与行首 @ 目标一致。");
  }
  if (invalidIntent) {
    repairHints.push(`intent 必须是以下值之一: ${HANDOFF_INTENTS.join(", ")}。`);
  }

  return {
    ok,
    // Field completeness only; toMismatch is a separate routing signal (G3).
    degraded: !ok,
    missing,
    missingRecommended,
    score,
    hasBlock: true,
    emptyPacket: false,
    toMismatch,
    repairHints,
    riskFlags,
    intent: opts.intent || inferIntent(handoff, opts),
    policy: opts.policy || null,
  };
}

/**
 * packet.to vs routed @ target. Missing `to` is incompleteness, not mismatch.
 * @param {Handoff | null} handoff
 * @param {string} [routedTo]
 */
function computeToMismatch(handoff, routedTo) {
  if (!handoff || !routedTo) return false;
  const to = normalizeTo(handoff.to);
  if (!to) return false;
  return !toMatchesRoute(handoff.to, routedTo);
}

/**
 * Weak intent inference for quality metadata (Wave H0; H4 may promote to protocol).
 * @param {Handoff | null} handoff
 * @param {{ fromAgentId?: string, toAgentId?: string, routedTo?: string, useWorktree?: boolean, intent?: string|null }} [opts]
 * @returns {string|null}
 */
function inferIntent(handoff, opts = {}) {
  if (opts.intent) return normalizeIntent(opts.intent);
  if (handoff?.intent) return normalizeIntent(handoff.intent);
  const from = String(opts.fromAgentId || "")
    .trim()
    .toLowerCase();
  const to = String(opts.toAgentId || opts.routedTo || "")
    .trim()
    .toLowerCase();
  if (REVIEWER_AGENT_IDS.has(from) && IMPLEMENTER_AGENT_IDS.has(to)) return "fix";
  if (REVIEWER_AGENT_IDS.has(to)) return "review";
  if (opts.useWorktree) return "implement";
  if (handoff && typeof handoff.what === "string") {
    const what = handoff.what.toLowerCase();
    if (/request-changes|approve-with-nits|\bp0\b|评审|review/.test(what)) return "review";
  }
  return null;
}

function normalizeIntent(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return HANDOFF_INTENTS.includes(normalized) ? normalized : null;
}

function normalizeRiskFlags(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((flag) => typeof flag === "string" && flag).slice();
}

function hasValue(v) {
  if (Array.isArray(v)) return v.length > 0;
  return typeof v === "string" && v.trim().length > 0;
}

module.exports = {
  REQUIRED_FIELDS,
  RECOMMENDED_FIELDS,
  LIST_FIELDS,
  SCALAR_FIELDS,
  ALL_KNOWN_FIELDS,
  parseHandoffBlocks,
  parseHandoffBody,
  extractPrimaryHandoff,
  extractPrimaryHandoffMatch,
  selectCanonicalHandoffMatch,
  isMultiTarget,
  toMatchesRoute,
  normalizeTo,
  evaluateHandoff,
  computeToMismatch,
  inferIntent,
  normalizeIntent,
  normalizeRiskFlags,
  hasValue,
};

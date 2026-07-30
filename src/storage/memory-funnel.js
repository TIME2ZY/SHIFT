/**
 * Memory retrieve funnel: rank → select (dedup/slots) → render accounting.
 * Phase 4 — fills collab-contracts MEMORY_FUNNEL_* without claiming used/correct.
 */

"use strict";

const { canonicalizeTopic } = require("./memory-topic-canon");
const { MEMORY_DROP_REASONS, MEMORY_FUNNEL_LAYERS } = require("../shared/collab-contracts");

const PRODUCT_KINDS = new Set(["decision", "constraint", "fact"]);

function isProductKind(kind) {
  return PRODUCT_KINDS.has(kind);
}

function topicOf(item) {
  const raw = item?.topic || item?.metadata?.topic || "";
  if (!raw) return null;
  try {
    return canonicalizeTopic(raw);
  } catch {
    return String(raw).slice(0, 80);
  }
}

/**
 * Pull topic-like tokens from the user/agent prompt for guaranteed slots.
 * @param {string} prompt
 * @returns {string[]}
 */
function extractQueryTopicHints(prompt) {
  const text = String(prompt || "");
  if (!text.trim()) return [];
  const hints = new Set();
  // Explicit topic: / topic= / 「auth-token-ttl」 style
  const re =
    /\b((?:auth|storage|local|dev|token|session|login|password|port)[-a-z0-9\u4e00-\u9fff]{2,40})\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    try {
      hints.add(canonicalizeTopic(m[1]));
    } catch {
      hints.add(String(m[1]).toLowerCase().slice(0, 80));
    }
  }
  // Bare canonical keys mentioned as words
  for (const key of [
    "auth-token-ttl",
    "auth-no-refresh",
    "auth-session-model",
    "auth-login-contract",
    "storage-primary",
    "local-dev-port",
  ]) {
    if (text.toLowerCase().includes(key)) hints.add(key);
  }
  return [...hints].slice(0, 8);
}

/**
 * Deduplicate product memories by canonical topic; keep highest score.
 * Rows outside the product contract pass through defensively without topic collapse.
 *
 * @param {object[]} ranked
 * @returns {{ ranked: object[], dropped: object[] }}
 */
function dedupeRankedByTopic(ranked) {
  const list = Array.isArray(ranked) ? ranked : [];
  const bestByTopic = new Map();
  const dropped = [];
  const passthrough = [];

  for (const item of list) {
    if (!item) continue;
    if (!isProductKind(item.kind)) {
      passthrough.push(item);
      continue;
    }
    const topic = topicOf(item);
    if (!topic) {
      passthrough.push(item);
      continue;
    }
    const prev = bestByTopic.get(topic);
    if (!prev) {
      bestByTopic.set(topic, item);
      continue;
    }
    const prevScore = Number(prev.score) || 0;
    const nextScore = Number(item.score) || 0;
    const prevTs = String(prev.createdAt || "");
    const nextTs = String(item.createdAt || "");
    const preferNext =
      nextScore > prevScore || (nextScore === prevScore && nextTs > prevTs);
    if (preferNext) {
      dropped.push({
        id: prev.id,
        topic,
        kind: prev.kind,
        dropReason: MEMORY_DROP_REASONS.TOPIC_DEDUP,
        score: prev.score,
      });
      bestByTopic.set(topic, item);
    } else {
      dropped.push({
        id: item.id,
        topic,
        kind: item.kind,
        dropReason: MEMORY_DROP_REASONS.TOPIC_DEDUP,
        score: item.score,
      });
    }
  }

  const product = [...bestByTopic.values()];
  const merged = [...product, ...passthrough].sort((a, b) => {
    if ((Number(b.score) || 0) !== (Number(a.score) || 0)) {
      return (Number(b.score) || 0) - (Number(a.score) || 0);
    }
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });
  return { ranked: merged, dropped };
}

/**
 * Ensure query-hint topics appear in selected when present in ranked.
 * @param {object[]} selected
 * @param {object[]} ranked
 * @param {string[]} queryTopics
 * @param {number} totalLimit
 */
function applyGuaranteedSlots(selected, ranked, queryTopics, totalLimit) {
  if (!queryTopics.length) return { selected, guaranteed: [] };
  const selectedIds = new Set(selected.map((i) => i.id));
  const guaranteed = [];
  for (const topic of queryTopics) {
    if (selected.length >= totalLimit) break;
    const hit = ranked.find(
      (item) => isProductKind(item.kind) && topicOf(item) === topic && !selectedIds.has(item.id)
    );
    if (!hit) continue;
    // Evict the lowest-score non-product row if legacy data reaches this boundary.
    if (selected.length >= totalLimit) {
      let evictIdx = -1;
      let evictScore = Infinity;
      for (let i = 0; i < selected.length; i++) {
        const t = topicOf(selected[i]);
        if (t && queryTopics.includes(t)) continue;
        if (!isProductKind(selected[i].kind)) {
          const s = Number(selected[i].score) || 0;
          if (s < evictScore) {
            evictScore = s;
            evictIdx = i;
          }
        }
      }
      if (evictIdx >= 0) {
        const [removed] = selected.splice(evictIdx, 1);
        selectedIds.delete(removed.id);
      } else {
        break;
      }
    }
    selected.push(hit);
    selectedIds.add(hit.id);
    guaranteed.push(topic);
  }
  return { selected, guaranteed };
}

/**
 * Build funnel stats object for inject SSE / metrics.
 */
function buildFunnelStats({
  retrieved = 0,
  ranked = 0,
  selected = 0,
  rendered = 0,
  delivered = null,
  used = null,
  correct = null,
  dropped = 0,
  dropReason = null,
  truncated = false,
  guaranteedTopics = [],
  droppedTopics = [],
  conflictCount = 0,
} = {}) {
  return {
    retrieved,
    ranked,
    selected,
    rendered,
    delivered: delivered === null ? rendered : delivered,
    used,
    correct,
    dropped,
    dropReason,
    truncated: Boolean(truncated),
    guaranteedTopics: guaranteedTopics.slice(0, 12),
    droppedTopics: droppedTopics.slice(0, 16),
    conflictCount: Number(conflictCount) || 0,
    layers: MEMORY_FUNNEL_LAYERS,
  };
}

/**
 * Reject capture content that contains Unicode replacement characters.
 * @returns {{ ok: boolean, reason?: string }}
 */
function validateCaptureEncoding(content) {
  const text = String(content || "");
  // Unicode replacement character indicates decode failure upstream.
  if (text.includes("\uFFFD")) {
    return { ok: false, reason: MEMORY_DROP_REASONS.ENCODING };
  }
  return { ok: true };
}

module.exports = {
  isProductKind,
  topicOf,
  extractQueryTopicHints,
  dedupeRankedByTopic,
  applyGuaranteedSlots,
  buildFunnelStats,
  validateCaptureEncoding,
  MEMORY_DROP_REASONS,
};

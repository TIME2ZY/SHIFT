/**
 * Recall observability and availability rendering.
 *
 * The search and inject-pack paths both need the one-line search metric log,
 * the per-layer hit tallies the MCP bridge reports, and the availability
 * cards an unavailable or degraded memory system renders into the prompt.
 * Every function here is pure: callers pass the logger where needed, so the
 * module holds no service state and can be unit-tested without storage.
 */

"use strict";

/**
 * Emit one search metric line. Never uses error for a successful search —
 * tests and ops dashboards treat error as a failure.
 *
 * @param {object} metrics search metrics
 * @param {object} logger logger with info/log
 * @returns {void}
 */
function logSearchMetrics(metrics, logger) {
  const line =
    `[recall-search] thread=${metrics.threadId}` +
    ` qChars=${String(metrics.query || "").length}` +
    ` terms=${(metrics.terms || []).length}` +
    ` weak=${metrics.weakQuery ? 1 : 0}` +
    ` source=${metrics.source}` +
    ` mode=${metrics.mode}` +
    ` hits=${metrics.hits}` +
    ` memory=${metrics.layers?.memory || 0}` +
    ` message=${metrics.layers?.message || 0}` +
    ` evidence=${metrics.layers?.evidence || 0}` +
    ` truncated=${metrics.truncated ? 1 : 0}` +
    ` ms=${metrics.ms}`;
  if (typeof logger.info === "function") logger.info(line);
  else if (typeof logger.log === "function") logger.log(line);
}

function layerHitCounts(hits = []) {
  const counts = { memoryHits: 0, messageHits: 0, evidenceHits: 0, projectDocHits: 0 };
  for (const hit of hits) {
    const layer = hit.layer || hit.metadata?.layer;
    if (layer === "memory") counts.memoryHits += 1;
    else if (layer === "message") counts.messageHits += 1;
    else if (layer === "evidence") counts.evidenceHits += 1;
    else if (layer === "project-doc") counts.projectDocHits += 1;
  }
  return counts;
}

function collectSearchHitIds(hits = []) {
  const memoryIds = [];
  const messageIds = [];
  const evidenceIds = [];
  const projectDocIds = [];
  const seen = {
    memory: new Set(),
    message: new Set(),
    evidence: new Set(),
    "project-doc": new Set(),
  };
  function push(list, set, value) {
    if (typeof value !== "string" || !value || set.has(value)) return;
    set.add(value);
    list.push(value);
  }
  for (const hit of hits) {
    const layer = hit.layer || hit.metadata?.layer;
    if (layer === "memory") {
      push(
        memoryIds,
        seen.memory,
        hit.memoryId || (hit.sourceKind === "memory-entry" ? hit.sourceId : null)
      );
    } else if (layer === "message") {
      push(messageIds, seen.message, hit.sourceId || hit.messageId);
    } else if (layer === "evidence") {
      push(evidenceIds, seen.evidence, hit.sourceId);
    } else if (layer === "project-doc") {
      push(projectDocIds, seen["project-doc"], hit.sourceId);
    }
  }
  return { memoryIds, messageIds, evidenceIds, projectDocIds };
}

function renderUnavailableMemoryCard(availability) {
  return [
    "<!-- Active Memories (unavailable) -->",
    "## 本 thread 活跃记忆（系统注入的历史数据）",
    "⚠ 记忆系统暂时不可用（非空库）。当前无法确认是否存在结构化记忆。",
    `原因: ${availability.reason || "unknown"}`,
    "请稍后重试 recall_search；不要假设「尚无记忆」。",
    "<!-- /Active Memories -->",
  ].join("\n");
}

function prependAvailabilityWarning(card, availability) {
  const warning = [
    "⚠ 记忆检索降级，结果可能不完整。",
    `degraded: ${availability.reason || "unknown"}`,
    "",
  ].join("\n");
  return warning + card;
}

module.exports = {
  logSearchMetrics,
  layerHitCounts,
  collectSearchHitIds,
  renderUnavailableMemoryCard,
  prependAvailabilityWarning,
};

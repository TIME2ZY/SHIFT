/**
 * Per-turn L3 memory write observability + inject payloads.
 * Opt-in terminal logs: SHIFT_MEMORY_METRICS_LOG=1
 */

const { ENV } = require("../shared/brand");

function isMemoryMetricsLogEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env[ENV.MEMORY_METRICS_LOG] || ""));
}

function emptyWriteStats() {
  return {
    upsertCallback: 0,
    errors: 0,
  };
}

function mergeWriteStats(base, extra) {
  const out = emptyWriteStats();
  const left = base && typeof base === "object" ? base : {};
  const right = extra && typeof extra === "object" ? extra : {};
  for (const key of Object.keys(out)) {
    out[key] = (Number(left[key]) || 0) + (Number(right[key]) || 0);
  }
  return out;
}

/**
 * @param {object} input
 * @returns {object}
 */
function buildMemoryWriteMetrics(input = {}) {
  const stats = mergeWriteStats(emptyWriteStats(), input.stats || input);
  return {
    kind: "memory_write",
    source: input.source || "unknown",
    threadId: input.threadId || null,
    invocationId: input.invocationId || null,
    agent: input.agent || null,
    ...stats,
    totalWrites: stats.upsertCallback,
  };
}

function formatMemoryWriteMetricsLine(metrics) {
  if (!metrics) return "";
  return (
    `[memory-metrics]` +
    ` kind=${metrics.kind}` +
    ` source=${metrics.source}` +
    ` agent=${metrics.agent || "?"}` +
    ` upsert=${metrics.upsertCallback}` +
    ` errors=${metrics.errors}` +
    ` totalWrites=${metrics.totalWrites}` +
    (metrics.threadId ? ` thread=${metrics.threadId}` : "") +
    (metrics.invocationId ? ` inv=${metrics.invocationId}` : "")
  );
}

function logMemoryWriteMetrics(metrics, logger = console, env = process.env) {
  if (!metrics || !isMemoryMetricsLogEnabled(env)) return false;
  const line = formatMemoryWriteMetricsLine(metrics);
  if (!line) return false;
  logger.log?.(line);
  return true;
}

/**
 * Slim inject payload for SSE / UI (never full fence JSON).
 */
function slimInjectItems(items, max = 12) {
  const list = Array.isArray(items) ? items : [];
  return list.slice(0, max).map((item) => ({
    id: item.id || null,
    kind: item.kind || null,
    status: item.status || null,
    scope: item.scope || null,
    authority: item.authority || null,
    activation: item.activation || null,
    topic: item.topic || item.metadata?.topic || null,
    content: String(item.content || "").slice(0, 120),
    score: typeof item.score === "number" ? item.score : undefined,
    channels: Array.isArray(item.channels) ? item.channels : undefined,
  }));
}

function normalizeAvailability(stats = {}) {
  const raw = stats.availability;
  if (raw && typeof raw === "object" && raw.state) {
    return {
      state: raw.state,
      empty: Boolean(raw.empty),
      partial: Boolean(raw.partial),
      reason: raw.reason || null,
    };
  }
  const empty =
    stats.empty === true ||
    (Array.isArray(stats.items) && stats.items.length === 0) ||
    false;
  return { state: "available", empty, partial: false, reason: null };
}

function buildMemoryInjectPayload(input = {}) {
  const items = slimInjectItems(input.items);
  const stats = input.stats && typeof input.stats === "object" ? input.stats : {};
  const availability = normalizeAvailability(stats);
  const funnel =
    stats.funnel && typeof stats.funnel === "object"
      ? stats.funnel
      : input.funnel && typeof input.funnel === "object"
        ? input.funnel
        : null;
  return {
    sessionId: input.sessionId || input.threadId || null,
    agent: input.agent || null,
    source: input.source || "bootstrap",
    items,
    count: items.length,
    stats: {
      usedChars: stats.usedChars,
      truncated: Boolean(stats.truncated),
      byKind: stats.byKind || {},
      weakQuery: Boolean(stats.weakQuery),
      channels: stats.channels || {},
      availability,
      budgetBuckets: stats.budgetBuckets || null,
      funnel,
    },
    availability,
    funnel,
  };
}

module.exports = {
  isMemoryMetricsLogEnabled,
  emptyWriteStats,
  mergeWriteStats,
  buildMemoryWriteMetrics,
  formatMemoryWriteMetricsLine,
  logMemoryWriteMetrics,
  slimInjectItems,
  buildMemoryInjectPayload,
  normalizeAvailability,
};

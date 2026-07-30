/**
 * Handoff observability metrics.
 *
 * Metrics continue to flow through SSE. Optional terminal logs let ops track:
 *   degraded_rate, repair_rate, capture_rate, a2a_prompt_has_memory
 * without stacking more agent-facing prose. Terminal output is opt-in via
 * SHIFT_HANDOFF_METRICS_LOG.
 */

function isHandoffMetricsLogEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.SHIFT_HANDOFF_METRICS_LOG || ""));
}

function rate(numerator, denominator) {
  const den = Number(denominator) || 0;
  if (den <= 0) return 0;
  const num = Number(numerator) || 0;
  return Math.round((num / den) * 1000) / 1000;
}

/**
 * Build one-shot metrics for a finalizeA2ARoutes call.
 * @param {object} input
 * @returns {object|null} null when there were no route mentions (no log noise)
 */
function buildFinalizeMetrics(input = {}) {
  const mentions = Array.isArray(input.mentions) ? input.mentions : [];
  if (mentions.length === 0) return null;

  const qualities = Object.values(input.handoffQualityByTarget || {});
  const targets = mentions.length;
  let ok = 0;
  let degraded = 0;
  let empty = 0;
  let hasBlock = 0;
  let toMismatch = 0;
  for (const quality of qualities) {
    if (!quality || typeof quality !== "object") continue;
    if (quality.ok) ok += 1;
    if (quality.degraded) degraded += 1;
    if (quality.emptyPacket || !quality.hasBlock) empty += 1;
    if (quality.hasBlock) hasBlock += 1;
    if (quality.toMismatch) toMismatch += 1;
  }

  const enqueued = Array.isArray(input.enqueued) ? input.enqueued.length : 0;
  const repairs = Array.isArray(input.repairs) ? input.repairs.length : 0;
  const skipped = Array.isArray(input.skipped) ? input.skipped.length : 0;
  const captured = Number(input.capturedCount) || 0;
  // Capture is only attempted when hasBlock; rate against hasBlock when available.
  const captureDenom = hasBlock > 0 ? hasBlock : 0;

  return {
    kind: "finalize",
    source: input.source || "unknown",
    mode: input.mode || "balanced",
    threadId: input.threadId || null,
    invocationId: input.invocationId || null,
    targets,
    enqueued,
    repairs,
    skipped,
    ok,
    degraded,
    empty,
    hasBlock,
    toMismatch,
    captured,
    ok_rate: rate(ok, targets),
    degraded_rate: rate(degraded, targets),
    empty_rate: rate(empty, targets),
    repair_rate: rate(repairs, targets),
    capture_rate: rate(captured, captureDenom),
  };
}

function formatFinalizeMetricsLine(metrics) {
  if (!metrics) return "";
  return (
    `[handoff-metrics]` +
    ` kind=finalize` +
    ` source=${metrics.source}` +
    ` mode=${metrics.mode}` +
    ` targets=${metrics.targets}` +
    ` enqueued=${metrics.enqueued}` +
    ` repairs=${metrics.repairs}` +
    ` skipped=${metrics.skipped}` +
    ` ok=${metrics.ok}` +
    ` degraded=${metrics.degraded}` +
    ` empty=${metrics.empty}` +
    ` hasBlock=${metrics.hasBlock}` +
    ` captured=${metrics.captured}` +
    ` toMismatch=${metrics.toMismatch}` +
    ` ok_rate=${metrics.ok_rate}` +
    ` degraded_rate=${metrics.degraded_rate}` +
    ` empty_rate=${metrics.empty_rate}` +
    ` repair_rate=${metrics.repair_rate}` +
    ` capture_rate=${metrics.capture_rate}` +
    (metrics.threadId ? ` thread=${metrics.threadId}` : "") +
    (metrics.invocationId ? ` inv=${metrics.invocationId}` : "")
  );
}

/**
 * True when the injected Active Memory Card carries at least one item.
 * @param {string|null|undefined} card
 */
function memoryCardHasActiveItems(card) {
  if (typeof card !== "string" || !card.trim()) return false;
  if (/Active Memories\s*\(\s*0\s*\)/.test(card)) return false;
  const countMatch = card.match(/Active Memories\s*\(\s*(\d+)\s*\)/);
  if (countMatch) return Number(countMatch[1]) > 0;
  // Fallback: rendered entries always include status tokens.
  return /\[active\]/.test(card);
}

/**
 * Metrics for A2A successor prompt injection (Receive Bundle path).
 * @param {object} input
 */
function buildA2AInjectMetrics(input = {}) {
  const memoryCard = typeof input.memoryCard === "string" ? input.memoryCard : "";
  const hasMemory = memoryCardHasActiveItems(memoryCard);
  return {
    kind: "a2a_inject",
    source: input.source || "chat",
    agent: input.agent || null,
    fromAgent: input.fromAgent || null,
    threadId: input.threadId || null,
    invocationId: input.invocationId || null,
    a2a_prompt_has_memory: hasMemory ? 1 : 0,
    memory_card_chars: memoryCard.length,
    prompt_bytes: Math.max(0, Number(input.promptBytes) || 0),
  };
}

function formatA2AInjectMetricsLine(metrics) {
  if (!metrics) return "";
  return (
    `[handoff-metrics]` +
    ` kind=a2a_inject` +
    ` source=${metrics.source}` +
    ` agent=${metrics.agent || "?"}` +
    ` from=${metrics.fromAgent || "?"}` +
    ` a2a_prompt_has_memory=${metrics.a2a_prompt_has_memory}` +
    ` memory_card_chars=${metrics.memory_card_chars}` +
    ` prompt_bytes=${metrics.prompt_bytes}` +
    (metrics.threadId ? ` thread=${metrics.threadId}` : "") +
    (metrics.invocationId ? ` inv=${metrics.invocationId}` : "")
  );
}

function logMetricsLine(line, logger = console, env = process.env) {
  if (!line || !isHandoffMetricsLogEnabled(env)) return;
  if (typeof logger.info === "function") logger.info(line);
  else if (typeof logger.log === "function") logger.log(line);
}

function logFinalizeMetrics(metrics, logger = console, env = process.env) {
  logMetricsLine(formatFinalizeMetricsLine(metrics), logger, env);
}

function logA2AInjectMetrics(metrics, logger = console, env = process.env) {
  logMetricsLine(formatA2AInjectMetricsLine(metrics), logger, env);
}

module.exports = {
  rate,
  buildFinalizeMetrics,
  formatFinalizeMetricsLine,
  memoryCardHasActiveItems,
  buildA2AInjectMetrics,
  formatA2AInjectMetricsLine,
  isHandoffMetricsLogEnabled,
  logFinalizeMetrics,
  logA2AInjectMetrics,
  logMetricsLine,
};

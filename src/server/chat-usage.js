/**
 * Chat billing / context-char helpers (Phase C-1 extract from chat-routes).
 * Pure functions — no request state.
 */

const BILLING_FIELDS = Object.freeze([
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningTokens",
  "totalTokens",
  "costUsd",
]);

function invocationUsageDelta(current = {}, baseline = {}) {
  const usage = {};
  for (const field of BILLING_FIELDS) {
    usage[field] = Math.max(0, Number(current[field] || 0) - Number(baseline[field] || 0));
  }
  if (usage.totalTokens === 0 && usage.inputTokens + usage.outputTokens > 0) {
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }
  return usage;
}

function contextCharsFromEvent(event) {
  if (!event || typeof event !== "object") return 0;
  if (event.type === "thinking.delta" || event.type === "commentary.delta") {
    return typeof event.text === "string" ? event.text.length : 0;
  }
  if (event.type !== "tool.finished") return 0;

  // Context accounting follows the canonical value retained in model-visible
  // history. original*Chars describes the CLI transport before truncation and
  // can be orders of magnitude larger than what the provider kept.
  const value = event.output !== undefined ? event.output : event.result;
  if (typeof value === "string") return value.length;
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value).length;
    } catch {
      return 0;
    }
  }
  return 0;
}

module.exports = {
  BILLING_FIELDS,
  invocationUsageDelta,
  contextCharsFromEvent,
};

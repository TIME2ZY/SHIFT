const { makeEvent } = require("./event-protocol");
const { normalizeBillingUsage } = require("../shared/usage-contract");

const ALIASES = Object.freeze({
  inputTokens: ["inputTokens", "input_tokens", "input", "promptTokens", "prompt_tokens"],
  cachedInputTokens: [
    "cachedInputTokens",
    "cached_input_tokens",
    "cacheReadInputTokens",
    "cache_read_input_tokens",
    "cacheRead",
    "cache_read",
  ],
  outputTokens: [
    "outputTokens",
    "output_tokens",
    "output",
    "completionTokens",
    "completion_tokens",
  ],
  reasoningTokens: [
    "reasoningTokens",
    "reasoning",
    "reasoning_tokens",
    "reasoningOutputTokens",
    "reasoning_output_tokens",
    "thinkingTokens",
    "thinking",
    "thinking_tokens",
  ],
  totalTokens: ["totalTokens", "total_tokens", "total"],
  costUsd: ["costUsd", "cost_usd", "cost"],
  contextTokens: ["contextTokens", "context_tokens"],
  contextWindowTokens: [
    "contextWindowTokens",
    "context_window_tokens",
    "modelContextWindow",
    "model_context_window",
  ],
});

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function firstValue(source, aliases) {
  for (const key of aliases) {
    const value = finiteNonNegative(source && source[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function usageSource(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.tokens && typeof raw.tokens === "object" && !Array.isArray(raw.tokens)) {
    return { ...raw, ...raw.tokens };
  }
  return raw;
}

function nestedTotal(value) {
  if (value == null) return undefined;
  if (typeof value === "number") return finiteNonNegative(value);
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  return firstValue(value, ["totalTokens", "total_tokens", "total"]);
}

function normalizeUsage(raw, options = {}) {
  const source = usageSource(raw);
  if (!source) return null;
  const normalized = {};
  for (const [field, aliases] of Object.entries(ALIASES)) {
    const value = firstValue(source, aliases);
    if (value !== undefined) normalized[field] = value;
  }

  const cache = source.cache && typeof source.cache === "object" ? source.cache : null;
  if (normalized.cachedInputTokens === undefined && cache) {
    normalized.cachedInputTokens = firstValue(cache, ["read", "input", "tokens"]);
  }
  if (normalized.costUsd === undefined && source.cost && typeof source.cost === "object") {
    normalized.costUsd = firstValue(source.cost, ["usd", "total"]);
  }
  if (normalized.contextTokens === undefined) {
    const contextTokens = nestedTotal(source.last_token_usage ?? source.lastTokenUsage);
    if (contextTokens !== undefined) normalized.contextTokens = contextTokens;
  }

  if (Object.keys(normalized).length === 0) return null;
  const billing = normalizeBillingUsage(normalized, options);
  for (const field of [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens",
    "costUsd",
  ]) {
    delete normalized[field];
  }
  Object.assign(normalized, billing);
  if (options.contextTokensExact === true && normalized.contextTokens !== undefined) {
    normalized.contextTokensExact = true;
  }
  return normalized;
}

function makeUsageEvent(base, raw, options = {}) {
  const usage = normalizeUsage(raw, options);
  if (!usage) return null;
  return makeEvent("usage.update", {
    ...base,
    scope: options.scope || "run",
    mode: options.mode || "cumulative",
    ...(options.counterScope ? { counterScope: options.counterScope } : {}),
    ...usage,
    ...(options.includeRaw === true ? { providerRaw: raw } : {}),
  });
}

function createUsageAccumulator() {
  const snapshots = new Map();
  return {
    accept(event) {
      if (!event || event.type !== "usage.update") return event;
      if (event.mode === "delta") return event;
      const key = `${event.scope}:${event.mode}`;
      const signature = JSON.stringify([
        event.inputTokens,
        event.cachedInputTokens,
        event.outputTokens,
        event.reasoningTokens,
        event.totalTokens,
        event.costUsd,
        event.contextTokens,
      ]);
      if (snapshots.get(key) === signature) return null;
      snapshots.set(key, signature);
      return event;
    },
  };
}

module.exports = {
  ALIASES,
  normalizeUsage,
  makeUsageEvent,
  createUsageAccumulator,
};

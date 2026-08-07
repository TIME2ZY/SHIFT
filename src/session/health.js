const {
  AGENTS,
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_RESERVE_RATIO,
  getAgentModelProfile,
} = require("../agents/catalog");
const { resolveSealThresholds } = require("./context-budget");
const { ENV } = require("../shared/brand");

const CHARS_PER_TOKEN = 4;
const DEFAULT_CAPACITY_TOKENS = DEFAULT_CONTEXT_TOKENS;

function getAgentCapacity(agentId) {
  const envOverride = Number(process.env[ENV.TEST_CAPACITY]);
  if (Number.isFinite(envOverride) && envOverride > 0) return envOverride;
  const agent = AGENTS[agentId];
  if (!agent) return DEFAULT_CAPACITY_TOKENS;
  if (agent.capacityTokens) return agent.capacityTokens;
  const modelProfile = getAgentModelProfile(agentId);
  return modelProfile ? modelProfile.contextTokens : DEFAULT_CAPACITY_TOKENS;
}

function getAgentReserveRatio(agentId) {
  const modelProfile = getAgentModelProfile(agentId);
  return modelProfile && typeof modelProfile.reserveRatio === "number"
    ? modelProfile.reserveRatio
    : DEFAULT_RESERVE_RATIO;
}

/**
 * Native-compact-aware seal budget for an agent (usable + physical thresholds).
 * @param {string} agentId
 * @param {{ capacityTokens?: number, reserveRatio?: number }} [opts]
 */
function getAgentSealThresholds(agentId, opts = {}) {
  const modelProfile = getAgentModelProfile(agentId) || {};
  const capacityTokens =
    typeof opts.capacityTokens === "number" && opts.capacityTokens > 0
      ? opts.capacityTokens
      : getAgentCapacity(agentId);
  const reserveRatio =
    typeof opts.reserveRatio === "number"
      ? opts.reserveRatio
      : getAgentReserveRatio(agentId);
  return resolveSealThresholds({
    ...modelProfile,
    contextTokens: capacityTokens,
    reserveRatio,
  });
}

function makeTracker(agentId, opts = {}) {
  const capacityTokens = opts.capacityTokens || getAgentCapacity(agentId);
  const reserveRatio = validRatio(opts.reserveRatio, getAgentReserveRatio(agentId));
  const reserveTokens = Math.floor(capacityTokens * reserveRatio);
  const usableContextTokens = Math.max(1, capacityTokens - reserveTokens);
  let inputChars = nonNegativeNumber(opts.inputChars);
  let outputChars = nonNegativeNumber(opts.outputChars);
  const persistedContextSource = opts.contextUsageSource || "char_estimated";
  let providerContextTokens =
    persistedContextSource !== "char_estimated" ? nonNegativeNumber(opts.contextUsedTokens) : 0;
  let contextUsageSource = providerContextTokens > 0 ? persistedContextSource : "char_estimated";
  const billing = {
    inputTokens: nonNegativeNumber(opts.billingInputTokens),
    cachedInputTokens: nonNegativeNumber(opts.billingCachedInputTokens),
    outputTokens: nonNegativeNumber(opts.billingOutputTokens),
    reasoningTokens: nonNegativeNumber(opts.billingReasoningTokens),
    totalTokens: nonNegativeNumber(opts.billingTotalTokens),
    costUsd: nonNegativeNumber(opts.billingCostUsd),
  };
  const usageFields = [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens",
    "costUsd",
  ];
  const accountedInvocation = Object.fromEntries(usageFields.map((field) => [field, 0]));
  let highestUsageScope = -1;
  const startedAt = Date.now();

  function addInput(n) {
    if (typeof n === "number" && n > 0) inputChars += n;
  }

  function addOutput(n) {
    if (typeof n === "number" && n > 0) outputChars += n;
  }

  function getUsedChars() {
    return inputChars + outputChars;
  }

  function getEstimatedTokens() {
    return Math.floor(getUsedChars() / CHARS_PER_TOKEN);
  }

  function getUsedTokens() {
    return providerContextTokens > 0 ? providerContextTokens : getEstimatedTokens();
  }

  function getPhysicalFillRatio() {
    return getUsedTokens() / capacityTokens;
  }

  function getFillRatio() {
    return getUsedTokens() / usableContextTokens;
  }

  function applyUsage(event) {
    if (!event || event.type !== "usage.update") return false;
    if (event.contextTokensExact === true && typeof event.contextTokens === "number") {
      providerContextTokens = event.contextTokens;
      contextUsageSource = "provider_exact";
    }

    const scopeRank = { step: 0, turn: 1, run: 2 }[event.scope] ?? 0;
    if (scopeRank < highestUsageScope) return true;

    if (event.mode === "cumulative") {
      for (const field of usageFields) {
        if (typeof event[field] !== "number") continue;
        const delta = event[field] - accountedInvocation[field];
        billing[field] = Math.max(0, billing[field] + delta);
        accountedInvocation[field] = event[field];
      }
      highestUsageScope = scopeRank;
    } else if (scopeRank === highestUsageScope || highestUsageScope < 0) {
      for (const field of usageFields) {
        if (typeof event[field] !== "number") continue;
        billing[field] += event[field];
        accountedInvocation[field] += event[field];
      }
      highestUsageScope = scopeRank;
    }
    return true;
  }

  function snapshot() {
    const usedTokens = getUsedTokens();
    return {
      agentId,
      capacityTokens,
      contextWindowTokens: capacityTokens,
      reserveRatio,
      reserveTokens,
      usableContextTokens,
      inputChars,
      outputChars,
      usedChars: getUsedChars(),
      estimatedTokens: getEstimatedTokens(),
      usedTokens,
      contextUsedTokens: usedTokens,
      contextUsageSource,
      physicalFillRatio: getPhysicalFillRatio(),
      budgetFillRatio: getFillRatio(),
      fillRatio: getFillRatio(),
      billing: { ...billing },
      elapsedMs: Date.now() - startedAt,
    };
  }

  return {
    agentId,
    capacityTokens,
    reserveRatio,
    reserveTokens,
    usableContextTokens,
    addInput,
    addOutput,
    applyUsage,
    getUsedChars,
    getUsedTokens,
    getPhysicalFillRatio,
    getFillRatio,
    snapshot,
  };
}

function validRatio(value, fallback) {
  return typeof value === "number" && value >= 0 && value < 1 ? value : fallback;
}

function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

module.exports = {
  makeTracker,
  getAgentCapacity,
  getAgentReserveRatio,
  getAgentSealThresholds,
  CHARS_PER_TOKEN,
  DEFAULT_CAPACITY_TOKENS,
  DEFAULT_RESERVE_RATIO,
};

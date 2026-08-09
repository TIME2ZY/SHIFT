const BILLING_FIELDS = Object.freeze([
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningTokens",
  "totalTokens",
  "costUsd",
]);

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

/**
 * Normalize provider billing counters into one invariant contract:
 * - inputTokens includes cached input
 * - outputTokens includes reasoning output
 * - cachedInputTokens/reasoningTokens are subsets
 * - totalTokens equals inputTokens + outputTokens when components exist
 */
function normalizeBillingUsage(values = {}, options = {}) {
  const cachedInputMode = options.cachedInputMode || "included";
  const reasoningOutputMode = options.reasoningOutputMode || "included";
  if (!new Set(["included", "additional"]).has(cachedInputMode)) {
    throw new Error(`Unsupported cachedInputMode "${cachedInputMode}".`);
  }
  if (!new Set(["included", "additional"]).has(reasoningOutputMode)) {
    throw new Error(`Unsupported reasoningOutputMode "${reasoningOutputMode}".`);
  }

  const rawInput = finiteNonNegative(values.inputTokens);
  const cached = finiteNonNegative(values.cachedInputTokens);
  const rawOutput = finiteNonNegative(values.outputTokens);
  const reasoning = finiteNonNegative(values.reasoningTokens);
  const reportedTotal = finiteNonNegative(values.totalTokens);
  const costUsd = finiteNonNegative(values.costUsd);
  const hasComponents =
    rawInput !== undefined ||
    cached !== undefined ||
    rawOutput !== undefined ||
    reasoning !== undefined;

  let input = rawInput || 0;
  let output = rawOutput || 0;
  if (cachedInputMode === "additional") input += cached || 0;
  else input = Math.max(input, cached || 0);
  if (reasoningOutputMode === "additional") output += reasoning || 0;
  else output = Math.max(output, reasoning || 0);

  // Older persisted events can contain only provider counters plus an
  // authoritative total. Reconcile the unattributed remainder without
  // changing the canonical total. A remainder exactly equal to reasoning is
  // an older "reasoning is additional" shape; other remainder is input-side
  // provider accounting such as cache writes.
  if (hasComponents && reportedTotal !== undefined && reportedTotal > input + output) {
    const remainder = reportedTotal - input - output;
    if (
      reasoningOutputMode === "included" &&
      reasoning !== undefined &&
      reasoning > 0 &&
      remainder === reasoning
    ) {
      output += remainder;
    } else {
      input += remainder;
    }
  }

  const normalized = {};
  if (hasComponents) {
    normalized.inputTokens = input;
    normalized.cachedInputTokens = cached || 0;
    normalized.outputTokens = output;
    normalized.reasoningTokens = reasoning || 0;
    normalized.totalTokens = input + output;
  } else if (reportedTotal !== undefined) {
    normalized.totalTokens = reportedTotal;
  }
  if (costUsd !== undefined) normalized.costUsd = costUsd;
  return normalized;
}

module.exports = {
  BILLING_FIELDS,
  normalizeBillingUsage,
};

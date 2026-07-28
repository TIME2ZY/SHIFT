/**
 * Pure helpers for pre-call context projection and soft/emergency seal decisions.
 * Shared by chat-routes and live tests.
 *
 * projected = current + estimatedFullPrompt + expectedOutputReserve
 */

const DEFAULT_OUTPUT_RESERVE_TOKENS = 6144;
const DEFAULT_NEXT_TURN_MIN_BUDGET = 10_000;
const CHARS_PER_TOKEN = 4;

/**
 * @param {object} input
 * @param {number} input.currentContextTokens
 * @param {number} [input.estimatedFullPromptTokens]
 * @param {number} [input.estimatedFullPromptChars]
 * @param {number} [input.expectedOutputReserve]
 * @param {number[]} [input.recentOutputTokens] recent turn outputs for P90
 * @returns {{ projected: number, expectedOutputReserve: number, promptTokens: number }}
 */
function projectTurnBudget(input = {}) {
  const current = nonNeg(input.currentContextTokens);
  const promptTokens =
    input.estimatedFullPromptTokens != null
      ? nonNeg(input.estimatedFullPromptTokens)
      : charsToTokens(input.estimatedFullPromptChars);
  const expectedOutputReserve = resolveOutputReserve(input);
  return {
    projected: current + promptTokens + expectedOutputReserve,
    expectedOutputReserve,
    promptTokens,
  };
}

/**
 * @param {object} input
 * @param {number} input.usableContextTokens
 * @param {number} input.projected
 * @param {number} [input.safetySlack=0]
 */
function shouldPreSealRotate(input = {}) {
  const usable = Math.max(1, nonNeg(input.usableContextTokens));
  const projected = nonNeg(input.projected);
  const slack = nonNeg(input.safetySlack);
  return projected >= usable - slack;
}

/**
 * Soft seal after a complete turn: remaining usable below next-turn budget,
 * or used fraction above soft ratio.
 */
function shouldSoftSealAfterTurn(input = {}) {
  const usable = Math.max(1, nonNeg(input.usableContextTokens));
  const used = nonNeg(input.usedTokens);
  const remaining = Math.max(0, usable - used);
  const nextMin =
    input.nextTurnMinimumBudget != null
      ? nonNeg(input.nextTurnMinimumBudget)
      : DEFAULT_NEXT_TURN_MIN_BUDGET;
  const softRatio =
    typeof input.softRatio === "number" && input.softRatio > 0 ? input.softRatio : 0.9;

  if (remaining < nextMin) {
    return { seal: true, reason: "remaining-below-next-turn-budget", remaining, nextMin };
  }
  if (used / usable >= softRatio) {
    return { seal: true, reason: "soft-ratio", ratio: used / usable, softRatio };
  }
  return { seal: false, reason: null, remaining, ratio: used / usable };
}

/**
 * Emergency mid-run kill only near physical capacity.
 */
function shouldEmergencyStop(input = {}) {
  const physical = Math.max(1, nonNeg(input.physicalContextTokens));
  const used = nonNeg(input.usedTokens);
  const threshold =
    typeof input.physicalKillRatio === "number" ? input.physicalKillRatio : 0.98;
  const providerOverflow = Boolean(input.providerContextOverflow);
  if (providerOverflow) return { stop: true, reason: "provider-overflow" };
  if (used / physical >= threshold) {
    return { stop: true, reason: "physical-ceiling", ratio: used / physical };
  }
  return { stop: false, reason: null };
}

function resolveOutputReserve(input) {
  if (input.expectedOutputReserve != null) return nonNeg(input.expectedOutputReserve);
  const recent = Array.isArray(input.recentOutputTokens)
    ? input.recentOutputTokens.map(nonNeg).filter((n) => n > 0)
    : [];
  if (recent.length === 0) return DEFAULT_OUTPUT_RESERVE_TOKENS;
  const p90 = percentile(recent, 0.9);
  return Math.max(DEFAULT_OUTPUT_RESERVE_TOKENS, p90);
}

function charsToTokens(chars) {
  return Math.floor(nonNeg(chars) / CHARS_PER_TOKEN);
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[Math.max(0, idx)];
}

function nonNeg(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return v;
}

/**
 * Usable tokens from physical capacity and reserve ratio.
 */
function usableFromPhysical(physicalTokens, reserveRatio = 0.2) {
  const physical = Math.max(1, nonNeg(physicalTokens));
  const ratio =
    typeof reserveRatio === "number" && reserveRatio >= 0 && reserveRatio < 1
      ? reserveRatio
      : 0.2;
  return Math.max(1, physical - Math.floor(physical * ratio));
}

module.exports = {
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  DEFAULT_NEXT_TURN_MIN_BUDGET,
  CHARS_PER_TOKEN,
  projectTurnBudget,
  shouldPreSealRotate,
  shouldSoftSealAfterTurn,
  shouldEmergencyStop,
  usableFromPhysical,
  charsToTokens,
  percentile,
};

// Re-export seal lifecycle helpers for live harness / single import path.
Object.assign(module.exports, require("./seal-lifecycle"));

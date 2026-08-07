/**
 * Pure helpers for pre-call context projection and soft/emergency seal decisions.
 * Shared by chat-routes and live tests.
 *
 * projected = current + estimatedFullPrompt + expectedOutputReserve
 *
 * Seal thresholds are native-compact-aware: SHIFT soft/action should land
 * before each provider's auto-compact (or quality cap). See resolveSealThresholds.
 */

const {
  DEFAULT_RESERVE_RATIO,
  DEFAULT_NATIVE_COMPACT_RATIO,
  DEFAULT_SEAL_MARGIN,
  DEFAULT_SEAL_SOFT_GAP,
  DEFAULT_SEAL_RECOVERY_GAP,
} = require("../agents/catalog");

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

/**
 * Derive SHIFT seal thresholds from a model profile (or raw options).
 *
 * Priority for soft/action absolute tokens:
 *   1. sealSoftTokens / sealActionTokens (quality caps, e.g. Gemini 300k)
 *   2. sealSoftUsableRatio / sealActionUsableRatio (explicit usable fractions)
 *   3. nativeCompact(Tokens|Ratio) − margin − softGap (physical-first)
 *
 * Sealer ratios are measured against usable capacity (physical × (1 − reserve)).
 *
 * @param {object} [input]
 * @param {number} [input.contextTokens]
 * @param {number} [input.reserveRatio]
 * @param {number} [input.nativeCompactRatio]
 * @param {number} [input.nativeCompactTokens]
 * @param {number} [input.sealMargin]
 * @param {number} [input.sealSoftGap]
 * @param {number} [input.sealRecoveryGap]
 * @param {number} [input.sealSoftTokens]
 * @param {number} [input.sealActionTokens]
 * @param {number} [input.sealSoftUsableRatio]
 * @param {number} [input.sealActionUsableRatio]
 */
function resolveSealThresholds(input = {}) {
  const capacity = Math.max(1, Math.floor(nonNeg(input.contextTokens) || 200_000));
  const reserveRatio = clampRatio(
    typeof input.reserveRatio === "number" ? input.reserveRatio : DEFAULT_RESERVE_RATIO,
    DEFAULT_RESERVE_RATIO
  );
  const usableTokens = usableFromPhysical(capacity, reserveRatio);
  const usableDenom = Math.max(1e-9, 1 - reserveRatio);

  const nativeTokens = resolveNativeCompactTokens(input, capacity);
  const nativePhysical = clamp(nativeTokens / capacity, 0.05, 1);

  const margin =
    typeof input.sealMargin === "number" && input.sealMargin >= 0
      ? input.sealMargin
      : DEFAULT_SEAL_MARGIN;
  const softGap =
    typeof input.sealSoftGap === "number" && input.sealSoftGap >= 0
      ? input.sealSoftGap
      : DEFAULT_SEAL_SOFT_GAP;
  const recoveryGap =
    typeof input.sealRecoveryGap === "number" && input.sealRecoveryGap >= 0
      ? input.sealRecoveryGap
      : DEFAULT_SEAL_RECOVERY_GAP;

  let actionTokens;
  let softTokens;
  let source = "native-margin";

  if (typeof input.sealActionTokens === "number" && input.sealActionTokens > 0) {
    actionTokens = Math.floor(input.sealActionTokens);
    softTokens =
      typeof input.sealSoftTokens === "number" && input.sealSoftTokens > 0
        ? Math.floor(input.sealSoftTokens)
        : Math.max(1, actionTokens - Math.floor(capacity * softGap));
    source = "absolute-tokens";
  } else if (
    typeof input.sealActionUsableRatio === "number" ||
    typeof input.sealSoftUsableRatio === "number"
  ) {
    const actionUsable =
      typeof input.sealActionUsableRatio === "number" && input.sealActionUsableRatio > 0
        ? input.sealActionUsableRatio
        : 1;
    const softUsable =
      typeof input.sealSoftUsableRatio === "number" && input.sealSoftUsableRatio > 0
        ? input.sealSoftUsableRatio
        : Math.max(0.05, actionUsable - softGap / usableDenom);
    actionTokens = Math.floor(usableTokens * actionUsable);
    softTokens = Math.floor(usableTokens * softUsable);
    source = "usable-ratio";
  } else {
    const actionPhysical = clamp(nativePhysical - margin, 0.1, 0.99);
    const softPhysical = clamp(actionPhysical - softGap, 0.05, actionPhysical - 0.01);
    actionTokens = Math.floor(capacity * actionPhysical);
    softTokens = Math.floor(capacity * softPhysical);
    source = "native-margin";
  }

  // Never plan to seal after native auto-compact.
  const nativeCap = Math.max(1, nativeTokens - 1);
  actionTokens = Math.min(actionTokens, nativeCap);
  softTokens = Math.min(softTokens, actionTokens);
  if (softTokens >= actionTokens) {
    softTokens = Math.max(1, actionTokens - Math.max(1, Math.floor(capacity * 0.02)));
  }

  const recoveryTokens = Math.max(
    1,
    Math.min(softTokens - 1, Math.floor(softTokens - capacity * recoveryGap))
  );

  const physical = {
    native: nativePhysical,
    soft: softTokens / capacity,
    action: actionTokens / capacity,
    recovery: recoveryTokens / capacity,
  };

  // Usable ratios can exceed 1.0 if action is past the reserve band; sealer clamps action ≤ 1.
  const usable = {
    soft: softTokens / usableTokens,
    action: actionTokens / usableTokens,
    recovery: recoveryTokens / usableTokens,
    warn: softTokens / usableTokens,
  };

  return {
    capacityTokens: capacity,
    reserveRatio,
    usableTokens,
    nativeCompactTokens: nativeTokens,
    nativeCompactRatio: nativePhysical,
    margin,
    softGap,
    recoveryGap,
    softTokens,
    actionTokens,
    recoveryTokens,
    physical,
    usable: {
      soft: usable.soft,
      action: usable.action,
      recovery: usable.recovery,
      warn: usable.warn,
      /** Ratios for makeSealer (action capped at 1.0 usable). */
      sealer: {
        warn: clamp(usable.warn, 0.05, 0.99),
        action: clamp(usable.action, 0.06, 1),
        recovery: clamp(Math.min(usable.recovery, usable.warn - 0.01), 0.01, 0.98),
      },
      softRatio: clamp(usable.soft, 0.05, 1.5),
    },
    source,
  };
}

function resolveNativeCompactTokens(input, capacity) {
  if (typeof input.nativeCompactTokens === "number" && input.nativeCompactTokens > 0) {
    return Math.min(capacity, Math.floor(input.nativeCompactTokens));
  }
  const ratio =
    typeof input.nativeCompactRatio === "number" && input.nativeCompactRatio > 0
      ? clamp(input.nativeCompactRatio, 0.05, 1)
      : DEFAULT_NATIVE_COMPACT_RATIO;
  return Math.floor(capacity * ratio);
}

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

function clampRatio(value, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1) {
    return fallback;
  }
  return value;
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
  resolveSealThresholds,
  charsToTokens,
  percentile,
};

// Re-export seal lifecycle helpers for live harness / single import path.
Object.assign(module.exports, require("./seal-lifecycle"));

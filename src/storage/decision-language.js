/**
 * Heuristics for "decision language" turns — used only for write rate
 * denominators. Not a substitute for true intent classification.
 */

const DECISION_PATTERNS = [
  /就用\s*\S+/u,
  /以后别/u,
  /以后不要/u,
  /必须\s*\S+/u,
  /禁止\s*\S+/u,
  /不要用\s*\S+/u,
  /改用\s*\S+/u,
  /定为\s*\S+/u,
  /拍板/u,
  /决定用/u,
  /决定采用/u,
  /\bwe (?:will |should )?(?:use|adopt|switch to)\b/i,
  /\blet'?s use\b/i,
  /\bdon'?t use\b/i,
  /\bmust (?:use|not)\b/i,
  /\bgoing forward\b/i,
  /\bfrom now on\b/i,
  /\buse\s+[A-Za-z][\w.-]+\s+(?:as|for)\b/i,
];

function looksLikeDecisionLanguage(text) {
  const value = String(text || "").trim();
  if (value.length < 4) return false;
  return DECISION_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * @param {{ decisionTurns: number, writeOrSuggestTurns: number }} counts
 * @returns {number|null} rate in [0,1] or null when denominator is 0
 */
function computeWriteOrSuggestRate(counts = {}) {
  const decisionTurns = Math.max(0, Number(counts.decisionTurns) || 0);
  const writeOrSuggestTurns = Math.max(0, Number(counts.writeOrSuggestTurns) || 0);
  if (decisionTurns === 0) return null;
  return Math.min(1, writeOrSuggestTurns / decisionTurns);
}

/**
 * Aggregate rates from memory_events counts for a thread.
 * decision_language_detected is the denominator signal when recorded.
 */
function ratesFromEventCounts(counts = {}) {
  const decisionTurns = Number(counts.decision_language_detected) || 0;
  const writeTurns = Number(counts.memory_written) || 0;
  // "Turns with write" is approximated by write events when turn tagging is absent.
  const writeOrSuggestRate = computeWriteOrSuggestRate({
    decisionTurns,
    writeOrSuggestTurns: writeTurns,
  });
  const injectRate =
    decisionTurns > 0
      ? Math.min(1, (Number(counts.memory_injected) || 0) / Math.max(decisionTurns, 1))
      : null;
  const searchRate =
    decisionTurns > 0
      ? Math.min(1, (Number(counts.memory_searched) || 0) / Math.max(decisionTurns, 1))
      : null;
  return {
    decisionTurns,
    writeOrSuggestEvents: writeTurns,
    writeOrSuggestRate,
    injectEvents: Number(counts.memory_injected) || 0,
    searchEvents: Number(counts.memory_searched) || 0,
    injectRate,
    searchRate,
    definitions: {
      writeOrSuggestRate:
        "turns_with_decision_language_and_write / turns_with_decision_language_detected",
      note: "Injected ≠ used. The write rate uses event counts as a proxy until turn-level tagging exists.",
    },
  };
}

module.exports = {
  looksLikeDecisionLanguage,
  computeWriteOrSuggestRate,
  ratesFromEventCounts,
  DECISION_PATTERNS,
};

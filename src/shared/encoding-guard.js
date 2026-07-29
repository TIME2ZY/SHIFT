/**
 * UTF-8 / replacement-character detection (phase 7).
 */

"use strict";

const REPLACEMENT = "\uFFFD";

/**
 * @param {string} text
 * @returns {{ ok: boolean, count: number, samples: string[] }}
 */
function scanReplacementChars(text) {
  const s = String(text || "");
  let count = 0;
  const samples = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === REPLACEMENT) {
      count += 1;
      if (samples.length < 3) {
        const from = Math.max(0, i - 12);
        const to = Math.min(s.length, i + 12);
        samples.push(s.slice(from, to));
      }
    }
  }
  return { ok: count === 0, count, samples };
}

/**
 * Cumulative counter for a stream/turn.
 */
function createEncodingTracker() {
  let total = 0;
  let warned = false;
  const samples = [];
  return {
    observe(text) {
      const hit = scanReplacementChars(text);
      if (hit.count === 0) return null;
      total += hit.count;
      for (const s of hit.samples) {
        if (samples.length < 5) samples.push(s);
      }
      const first = !warned;
      warned = true;
      return {
        first,
        count: hit.count,
        total,
        samples: hit.samples,
      };
    },
    snapshot() {
      return { total, warned, samples: samples.slice() };
    },
    hasWarning() {
      return total > 0;
    },
  };
}

module.exports = {
  REPLACEMENT,
  scanReplacementChars,
  createEncodingTracker,
};

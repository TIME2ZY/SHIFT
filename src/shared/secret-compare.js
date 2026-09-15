const crypto = require("node:crypto");

/**
 * Constant-time string comparison for secrets.
 *
 * String !== short-circuits on the first differing byte, so the time it takes
 * leaks how much of a token an attacker guessed right. Timing-safe comparison
 * avoids that, but requires equal-length buffers: the length check is the one
 * unavoidable leak, and it is negligible because all our secrets are
 * fixed-width CSPRNG output.
 *
 * Never use this for non-secret data — it is slower than === for no benefit.
 */
function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { safeEqual };

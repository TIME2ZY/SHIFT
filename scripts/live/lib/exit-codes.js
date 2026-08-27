"use strict";

const EXIT = { OK: 0, HARD_FAIL: 1, PREFLIGHT: 2, TIMEOUT: 3 };

function exitCodeForVerdict(verdict) {
  if (verdict === "dry-run" || verdict === "passed") return EXIT.OK;
  if (verdict === "timeout") return EXIT.TIMEOUT;
  if (verdict === "invalid-instance") return EXIT.PREFLIGHT;
  return EXIT.HARD_FAIL;
}

module.exports = { EXIT, exitCodeForVerdict };

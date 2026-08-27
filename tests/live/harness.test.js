/**
 * Deterministic tests for live harness home isolation and exit mapping.
 * Does not start the live server or spawn a real CLI.
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { ROOT } = require("../../src/shared/runtime-paths");
const { resolveLiveRuntimePaths } = require("../../scripts/live/lib/server");
const { EXIT, exitCodeForVerdict } = require("../../scripts/live/lib/exit-codes");

test("live defaults to an isolated SHIFT_HOME under output/live", () => {
  const isolated = path.join(ROOT, "tmp-live-home");
  const paths = resolveLiveRuntimePaths({
    shiftHome: isolated,
    env: { SHIFT_HOME: path.join(ROOT, "must-not-use") },
  });
  assert.equal(paths.shiftHome, isolated);
  assert.equal(paths.databaseFile, path.join(isolated, "data", "shift.sqlite"));
});

test("live fallback home is under output/live, not the interactive default", () => {
  const paths = resolveLiveRuntimePaths({
    env: { SHIFT_HOME: path.join(ROOT, "must-not-use") },
  });
  assert.equal(paths.shiftHome, path.join(ROOT, "output", "live", "home"));
});

test("useDefaultHome keeps the caller SHIFT_HOME", () => {
  const interactive = path.join(ROOT, "interactive-home");
  const paths = resolveLiveRuntimePaths({
    useDefaultHome: true,
    shiftHome: path.join(ROOT, "ignored"),
    env: { SHIFT_HOME: interactive },
  });
  assert.equal(paths.shiftHome, interactive);
});

test("exit codes distinguish invalid-instance preflight from hard fail", () => {
  assert.equal(exitCodeForVerdict("passed"), EXIT.OK);
  assert.equal(exitCodeForVerdict("dry-run"), EXIT.OK);
  assert.equal(exitCodeForVerdict("invalid-instance"), EXIT.PREFLIGHT);
  assert.equal(exitCodeForVerdict("timeout"), EXIT.TIMEOUT);
  assert.equal(exitCodeForVerdict("failed"), EXIT.HARD_FAIL);
  assert.equal(exitCodeForVerdict("error"), EXIT.HARD_FAIL);
});

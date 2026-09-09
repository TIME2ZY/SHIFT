const test = require("node:test");
const assert = require("node:assert/strict");
const {
  INVOCATION_STATES,
  TERMINAL_INVOCATION_STATES,
  toDbInvocationState,
  fromDbInvocationState,
  isTerminalInvocationState,
} = require("../../src/shared/collab-contracts");

test("INVOCATION_STATES includes RUNNING and canonical lifecycle states", () => {
  assert.equal(INVOCATION_STATES.CREATED, "created");
  assert.equal(INVOCATION_STATES.STARTED, "started");
  assert.equal(INVOCATION_STATES.RUNNING, "running");
  assert.equal(INVOCATION_STATES.STREAMING, "streaming");
  assert.equal(INVOCATION_STATES.COMPLETED, "completed");
  assert.equal(INVOCATION_STATES.FAILED, "failed");
  assert.equal(INVOCATION_STATES.CANCELLED, "cancelled");
  assert.equal(INVOCATION_STATES.SEALED, "sealed");
  assert.ok(TERMINAL_INVOCATION_STATES.includes(INVOCATION_STATES.COMPLETED));
  assert.ok(TERMINAL_INVOCATION_STATES.includes(INVOCATION_STATES.FAILED));
  assert.ok(TERMINAL_INVOCATION_STATES.includes(INVOCATION_STATES.CANCELLED));
  assert.ok(TERMINAL_INVOCATION_STATES.includes(INVOCATION_STATES.SEALED));
  assert.equal(isTerminalInvocationState(INVOCATION_STATES.COMPLETED), true);
  assert.equal(isTerminalInvocationState(INVOCATION_STATES.RUNNING), false);
});

test("toDbInvocationState maps RUNNING to active", () => {
  assert.equal(toDbInvocationState(INVOCATION_STATES.RUNNING), "active");
  assert.equal(toDbInvocationState(INVOCATION_STATES.STARTED), "active");
  assert.equal(toDbInvocationState(INVOCATION_STATES.CREATED), "active");
  assert.equal(toDbInvocationState(INVOCATION_STATES.STREAMING), "active");
  assert.equal(toDbInvocationState(INVOCATION_STATES.COMPLETED), "completed");
  assert.equal(toDbInvocationState(INVOCATION_STATES.FAILED), "failed");
  assert.equal(toDbInvocationState(INVOCATION_STATES.CANCELLED), "aborted");
  assert.equal(toDbInvocationState(INVOCATION_STATES.SEALED), "completed");
});

test("DB projection reports durable start without guessing from event counts", () => {
  for (const eventCount of [0, 1, 2, 50]) {
    assert.equal(fromDbInvocationState("active", { eventCount }), "started");
  }
  assert.equal(fromDbInvocationState("completed", { terminalReason: "sealed" }), "sealed");
  assert.equal(fromDbInvocationState("completed"), "completed");
  assert.equal(fromDbInvocationState("aborted"), "cancelled");
  assert.equal(fromDbInvocationState("failed"), "failed");
  assert.throws(() => fromDbInvocationState("unknown"), /Unknown DB/);
});

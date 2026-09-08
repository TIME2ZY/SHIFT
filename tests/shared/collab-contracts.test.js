const test = require("node:test");
const assert = require("node:assert/strict");
const {
  INVOCATION_STATES,
  TERMINAL_INVOCATION_STATES,
  INVOCATION_TRANSITIONS,
  toDbInvocationState,
  fromDbInvocationState,
  isTerminalInvocationState,
  assertValidTransition,
  validateTransitionSequence,
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

test("INVOCATION_TRANSITIONS enforces running stage and forbids skipping running", () => {
  assert.deepEqual(INVOCATION_TRANSITIONS[INVOCATION_STATES.STARTED], [
    INVOCATION_STATES.RUNNING,
    INVOCATION_STATES.FAILED,
    INVOCATION_STATES.CANCELLED,
  ]);

  assert.deepEqual(INVOCATION_TRANSITIONS[INVOCATION_STATES.RUNNING], [
    INVOCATION_STATES.STREAMING,
    INVOCATION_STATES.COMPLETED,
    INVOCATION_STATES.FAILED,
    INVOCATION_STATES.CANCELLED,
    INVOCATION_STATES.SEALED,
  ]);

  assert.deepEqual(INVOCATION_TRANSITIONS[INVOCATION_STATES.STREAMING], [
    INVOCATION_STATES.RUNNING,
    INVOCATION_STATES.COMPLETED,
    INVOCATION_STATES.FAILED,
    INVOCATION_STATES.CANCELLED,
    INVOCATION_STATES.SEALED,
  ]);
});

test("assertValidTransition rejects skipped transitions", () => {
  const jumpCheck = assertValidTransition(INVOCATION_STATES.STARTED, INVOCATION_STATES.COMPLETED);
  assert.equal(jumpCheck.ok, false);
  assert.match(jumpCheck.reason, /transition started → completed not allowed/);

  const sealedCheck = assertValidTransition(INVOCATION_STATES.STARTED, INVOCATION_STATES.SEALED);
  assert.equal(sealedCheck.ok, false);

  const createdToRunning = assertValidTransition(INVOCATION_STATES.CREATED, INVOCATION_STATES.RUNNING);
  assert.equal(createdToRunning.ok, false);

  const createdToCompleted = assertValidTransition(INVOCATION_STATES.CREATED, INVOCATION_STATES.COMPLETED);
  assert.equal(createdToCompleted.ok, false);

  assert.equal(assertValidTransition(INVOCATION_STATES.COMPLETED, INVOCATION_STATES.RUNNING).ok, false);
  assert.equal(assertValidTransition(INVOCATION_STATES.FAILED, INVOCATION_STATES.STARTED).ok, false);
  assert.equal(assertValidTransition(INVOCATION_STATES.CANCELLED, INVOCATION_STATES.RUNNING).ok, false);
});

test("assertValidTransition allows valid transitions", () => {
  assert.equal(assertValidTransition(null, INVOCATION_STATES.CREATED).ok, true);
  assert.equal(assertValidTransition(null, INVOCATION_STATES.STARTED).ok, true);
  assert.equal(assertValidTransition(INVOCATION_STATES.CREATED, INVOCATION_STATES.STARTED).ok, true);
  assert.equal(assertValidTransition(INVOCATION_STATES.STARTED, INVOCATION_STATES.RUNNING).ok, true);
  assert.equal(assertValidTransition(INVOCATION_STATES.RUNNING, INVOCATION_STATES.STREAMING).ok, true);
  assert.equal(assertValidTransition(INVOCATION_STATES.STREAMING, INVOCATION_STATES.RUNNING).ok, true);
  assert.equal(assertValidTransition(INVOCATION_STATES.RUNNING, INVOCATION_STATES.COMPLETED).ok, true);
  assert.equal(assertValidTransition(INVOCATION_STATES.STREAMING, INVOCATION_STATES.COMPLETED).ok, true);
  assert.equal(assertValidTransition(INVOCATION_STATES.RUNNING, INVOCATION_STATES.SEALED).ok, true);
  assert.equal(assertValidTransition(INVOCATION_STATES.STARTED, INVOCATION_STATES.FAILED).ok, true);
  assert.equal(assertValidTransition(INVOCATION_STATES.STARTED, INVOCATION_STATES.CANCELLED).ok, true);
  assert.equal(assertValidTransition(INVOCATION_STATES.RUNNING, INVOCATION_STATES.FAILED).ok, true);
  assert.equal(assertValidTransition(INVOCATION_STATES.RUNNING, INVOCATION_STATES.CANCELLED).ok, true);
});

test("validateTransitionSequence validates complete lifecycle progressions", () => {
  const happyPath = validateTransitionSequence([
    INVOCATION_STATES.CREATED,
    INVOCATION_STATES.STARTED,
    INVOCATION_STATES.RUNNING,
    INVOCATION_STATES.COMPLETED,
  ]);
  assert.equal(happyPath.ok, true);

  const streamingPath = validateTransitionSequence([
    INVOCATION_STATES.STARTED,
    INVOCATION_STATES.RUNNING,
    INVOCATION_STATES.STREAMING,
    INVOCATION_STATES.RUNNING,
    INVOCATION_STATES.COMPLETED,
  ]);
  assert.equal(streamingPath.ok, true);

  const abortPath = validateTransitionSequence([
    INVOCATION_STATES.STARTED,
    INVOCATION_STATES.RUNNING,
    INVOCATION_STATES.CANCELLED,
  ]);
  assert.equal(abortPath.ok, true);

  const skippingPath = validateTransitionSequence([
    INVOCATION_STATES.STARTED,
    INVOCATION_STATES.COMPLETED,
  ]);
  assert.equal(skippingPath.ok, false);
  assert.match(skippingPath.reason, /invalid transition at step 0/);

  assert.equal(validateTransitionSequence([]).ok, false);
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

test("fromDbInvocationState correctly identifies running from events and metadata", () => {
  assert.equal(fromDbInvocationState("active", { eventCount: 0 }), INVOCATION_STATES.CREATED);
  assert.equal(fromDbInvocationState("active", { eventCount: 1 }), INVOCATION_STATES.STARTED);
  assert.equal(fromDbInvocationState("active", { eventCount: 2 }), INVOCATION_STATES.RUNNING);
  assert.equal(fromDbInvocationState("active", { eventCount: 50 }), INVOCATION_STATES.RUNNING);

  assert.equal(fromDbInvocationState("active", { phase: "streaming" }), INVOCATION_STATES.STREAMING);
  assert.equal(fromDbInvocationState("active", { phase: "running" }), INVOCATION_STATES.RUNNING);
  assert.equal(fromDbInvocationState("active", { phase: "started" }), INVOCATION_STATES.STARTED);

  assert.equal(fromDbInvocationState("completed", { terminalReason: "sealed" }), INVOCATION_STATES.SEALED);
  assert.equal(fromDbInvocationState("completed", { terminalReason: "assistant-final" }), INVOCATION_STATES.COMPLETED);
  assert.equal(fromDbInvocationState("aborted"), INVOCATION_STATES.CANCELLED);
  assert.equal(fromDbInvocationState("failed"), INVOCATION_STATES.FAILED);
});

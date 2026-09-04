"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createHandoffConfirmationGate } = require("../../src/agents/handoff-confirmation");

test("confirmation applies edits before releasing the waiting thread", async () => {
  const gate = createHandoffConfirmationGate({ timeoutMs: 1000 });
  let received = null;
  const preview = gate.request({
    threadId: "thread-1",
    sourceInvocationId: "invocation-1",
    summary: { goal: "Original" },
    onConfirm(edits) {
      received = edits;
      return { enqueued: true };
    },
  });
  const waiting = gate.waitForThread("thread-1");

  const result = gate.confirm("thread-1", preview.previewId, { goal: "Edited" });
  await waiting;

  assert.deepEqual(received, { goal: "Edited" });
  assert.deepEqual(result.result, { enqueued: true });
  assert.deepEqual(gate.list("thread-1"), []);
});

test("cancellation releases the thread without confirming", async () => {
  const gate = createHandoffConfirmationGate({ timeoutMs: 1000 });
  let cancelled = null;
  const preview = gate.request({
    threadId: "thread-1",
    sourceInvocationId: "invocation-1",
    summary: {},
    onConfirm() {
      throw new Error("must not confirm");
    },
    onCancel(reason) {
      cancelled = reason;
    },
  });
  const waiting = gate.waitForThread("thread-1");
  gate.cancel("thread-1", preview.previewId);
  await waiting;

  assert.equal(cancelled, "cancelled");
});

test("timeout cancels the pending preview and releases the thread", async () => {
  const gate = createHandoffConfirmationGate({ timeoutMs: 20 });
  let cancelled = null;
  gate.request({
    threadId: "thread-timeout",
    sourceInvocationId: "invocation-timeout",
    summary: {},
    onConfirm() {},
    onCancel(reason) {
      cancelled = reason;
    },
  });

  await gate.waitForThread("thread-timeout");

  assert.equal(cancelled, "timeout");
  assert.deepEqual(gate.list("thread-timeout"), []);
});

test("aborting the source run cancels its previews and releases the thread", async () => {
  const gate = createHandoffConfirmationGate({ timeoutMs: 1000 });
  const controller = new AbortController();
  let cancelled = null;
  gate.request({
    threadId: "thread-abort",
    sourceInvocationId: "invocation-abort",
    summary: {},
    onConfirm() {},
    onCancel(reason) {
      cancelled = reason;
    },
  });
  const waiting = gate.waitForThread("thread-abort", controller.signal);

  controller.abort();
  await waiting;

  assert.equal(cancelled, "aborted");
  assert.deepEqual(gate.list("thread-abort"), []);
});

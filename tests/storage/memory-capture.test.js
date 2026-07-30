const assert = require("node:assert/strict");
const test = require("node:test");

const { createMemoryCapture } = require("../../src/storage/memory-capture");

function fixture() {
  const events = [];
  const capture = createMemoryCapture({
    eventStore: {
      append(event) {
        events.push(event);
      },
    },
  });
  return { capture, events };
}

test("structured handoff is persisted as collaboration state, not product Memory", () => {
  const { capture, events } = fixture();
  const result = capture.captureHandoff({
    id: "handoff-1",
    threadId: "thread-1",
    invocationId: "invocation-1",
    fromAgent: "codex",
    toAgent: "opencode",
    blockIndex: 0,
    quality: { hasBlock: true, ok: true, missing: [] },
    handoff: {
      goal: "Finish login",
      what: "Review the implementation",
      why: "Independent check",
      next_action: "Run tests",
    },
  });

  assert.equal(result.captured, true);
  assert.equal(result.memory, undefined);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "handoff-captured");
  assert.equal(events[0].payload.kind, "handoff");
});

test("window seal is persisted as recovery state, not product Memory", () => {
  const { capture, events } = fixture();
  const result = capture.captureWindowSeal({
    id: "seal-1",
    threadId: "thread-1",
    invocationId: "invocation-1",
    agentId: "codex",
    windowId: "window-1",
    reason: "post-turn-soft-seal",
    assistantContent: "Completed response.",
  });

  assert.equal(result.captured, true);
  assert.equal(result.memory, undefined);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "window-sealed");
  assert.equal(events[0].payload.kind, "window-seal");
});

test("missing handoff block remains a no-op", () => {
  const { capture, events } = fixture();
  const result = capture.captureHandoff({
    threadId: "thread-1",
    invocationId: "invocation-1",
    quality: { hasBlock: false },
  });
  assert.equal(result.captured, false);
  assert.deepEqual(events, []);
});

const assert = require("node:assert/strict");
const test = require("node:test");

const { createMemoryCapture } = require("../../src/storage/memory-capture");

test("createMemoryCapture rejects memoryService half-wiring (B-4)", () => {
  assert.throws(
    () =>
      createMemoryCapture({
        memoryService: {},
        eventStore: { append: () => ({}) },
      }),
    /does not accept memoryService/
  );
});

test("createMemoryCapture writes collaboration events not product rows", () => {
  const events = [];
  const capture = createMemoryCapture({
    eventStore: {
      append: (event) => {
        events.push(event);
        return { ok: true, event };
      },
    },
    allowTranscriptReplay: false,
  });

  const result = capture.captureHandoff({
    threadId: "t1",
    invocationId: "inv1",
    fromAgent: "codex",
    toAgent: "grok",
    blockIndex: 0,
    handoff: {
      to: "grok",
      what: "implement",
      why: "need",
      next_action: "edit",
    },
    quality: {
      ok: true,
      degraded: false,
      score: 1,
      missing: [],
      hasBlock: true,
    },
  });

  assert.equal(result.captured, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "handoff-captured");
  assert.equal(events[0].threadId, "t1");
  assert.equal(events[0].invocationId, "inv1");
});

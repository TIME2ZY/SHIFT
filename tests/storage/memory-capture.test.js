const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createMemoryCapture,
  collectResumeFacts,
  readLatestWindowSealEvent,
} = require("../../src/storage/memory-capture");

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
    userGoal: "Implement login",
    events: [{ kind: "tool.finished", payload: { path: "src/server/auth.js" } }],
  });

  assert.equal(result.captured, true);
  assert.equal(result.memory, undefined);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "window-sealed");
  assert.equal(events[0].payload.kind, "window-seal");
  assert.match(events[0].payload.content, /goal: Implement login/);
  assert.match(events[0].payload.content, /src\/server\/auth\.js/);
  assert.match(events[0].payload.content, /next_action:/);
  assert.match(events[0].payload.content, /不是产品 Memory/);
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

test("createMemoryCapture rejects memoryService half-wiring", () => {
  assert.throws(
    () =>
      createMemoryCapture({
        memoryService: {},
        eventStore: { append: () => ({}) },
      }),
    /does not accept memoryService/
  );
});

test("createMemoryCapture requires EventStore", () => {
  assert.throws(() => createMemoryCapture(), /requires an eventStore/);
});

test("collectResumeFacts extracts files and stderr without inventing paths", () => {
  const facts = collectResumeFacts([
    { kind: "tool.started", payload: { path: "src/foo.js" } },
    { kind: "file.changed", payload: { file: "src/foo.js" } },
    { kind: "stderr", payload: { text: "boom\nmore" } },
    { kind: "text.delta", payload: { text: "hello" } },
  ]);
  assert.deepEqual(facts.files, ["src/foo.js"]);
  assert.deepEqual(facts.errors, ["boom"]);
});

test("readLatestWindowSealEvent walks invocations newest-first", () => {
  const storage = {
    invocations: {
      listForThread() {
        return [{ id: "inv-1" }, { id: "inv-2" }];
      },
      listEvents(id) {
        if (id === "inv-1") {
          return [{ kind: "window-sealed", payload: { content: "old" } }];
        }
        return [
          { kind: "text.delta", payload: { text: "x" } },
          { kind: "window-sealed", payload: { content: "new-seal" } },
        ];
      },
    },
  };
  const latest = readLatestWindowSealEvent(storage, "thread-1");
  assert.equal(latest.payload.content, "new-seal");
});

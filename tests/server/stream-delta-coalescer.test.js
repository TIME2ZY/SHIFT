const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createStreamDeltaCoalescer,
  resolveCoalesceOptionsFromEnv,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_MS,
  PASSTHROUGH_NO_FLUSH,
} = require("../../src/server/stream-delta-coalescer");

function collectWrites(options = {}) {
  const writes = [];
  const coalescer = createStreamDeltaCoalescer({
    maxChars: 20,
    // A1 default is maxMs=0; tests that need idle pass maxMs explicitly.
    ...options,
    write: (kind, payload) => writes.push({ kind, payload }),
  });
  return { writes, coalescer };
}

test("coalesces consecutive text.delta under maxChars into one durable write", () => {
  const { writes, coalescer } = collectWrites({ maxChars: 40 });
  coalescer.accept({ type: "text.delta", agent: "a", text: "partial " });
  coalescer.accept({ type: "text.delta", agent: "a", text: "answer" });
  assert.equal(writes.length, 0, "still buffered under threshold");
  coalescer.flushAll();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, "text.delta");
  assert.equal(writes[0].payload.text, "partial answer");
});

test("coalesces commentary.delta without merging it into final text", () => {
  const { writes, coalescer } = collectWrites({ maxChars: 100 });
  coalescer.accept({ type: "commentary.delta", agent: "a", text: "working " });
  coalescer.accept({ type: "commentary.delta", agent: "a", text: "still" });
  coalescer.accept({ type: "text.delta", agent: "a", text: "final" });
  coalescer.flushAll();
  assert.deepEqual(
    writes.map(({ kind, payload }) => [kind, payload.text]),
    [
      ["commentary.delta", "working still"],
      ["text.delta", "final"],
    ]
  );
});

test("flushes text.delta when maxChars is reached", () => {
  const { writes, coalescer } = collectWrites({ maxChars: 10 });
  coalescer.accept({ type: "text.delta", agent: "a", text: "12345" });
  assert.equal(writes.length, 0);
  coalescer.accept({ type: "text.delta", agent: "a", text: "67890" });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].payload.text, "1234567890");
  coalescer.accept({ type: "text.delta", agent: "a", text: "x" });
  coalescer.flushAll();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].payload.text, "x");
});

test("hard-boundary events flush pending deltas first", () => {
  const { writes, coalescer } = collectWrites({ maxChars: 100 });
  coalescer.accept({ type: "text.delta", agent: "a", text: "hello" });
  coalescer.accept({
    type: "progress.update",
    agent: "a",
    items: [{ text: "step", done: true }],
  });
  assert.equal(writes.length, 2);
  assert.equal(writes[0].kind, "text.delta");
  assert.equal(writes[0].payload.text, "hello");
  assert.equal(writes[1].kind, "progress.update");
});

test("tool hard-boundary splits thinking monologue", () => {
  const { writes, coalescer } = collectWrites({ maxChars: 10_000 });
  coalescer.accept({ type: "thinking.delta", agent: "a", text: "before " });
  coalescer.accept({
    type: "tool.started",
    agent: "a",
    toolName: "read",
    toolId: "t1",
  });
  coalescer.accept({ type: "thinking.delta", agent: "a", text: "after" });
  coalescer.flushAll();
  assert.equal(writes.length, 3);
  assert.equal(writes[0].kind, "thinking.delta");
  assert.equal(writes[0].payload.text, "before ");
  assert.equal(writes[1].kind, "tool.started");
  assert.equal(writes[2].kind, "thinking.delta");
  assert.equal(writes[2].payload.text, "after");
});

test("interleaved thinking/text flushes on kind switch (strategy A)", () => {
  const { writes, coalescer } = collectWrites({ maxChars: 10_000 });
  // Mirrors Grok: think → text → think → text micro-interleave.
  coalescer.accept({ type: "thinking.delta", agent: "a", text: "plan " });
  coalescer.accept({ type: "text.delta", agent: "a", text: "hello " });
  assert.equal(writes.length, 1, "kind switch flushes prior thinking streak");
  assert.equal(writes[0].kind, "thinking.delta");
  assert.equal(writes[0].payload.text, "plan ");

  coalescer.accept({ type: "thinking.delta", agent: "a", text: "more" });
  assert.equal(writes.length, 2, "kind switch flushes prior text streak");
  assert.equal(writes[1].kind, "text.delta");
  assert.equal(writes[1].payload.text, "hello ");

  coalescer.accept({ type: "text.delta", agent: "a", text: "world" });
  assert.equal(writes.length, 3);
  assert.equal(writes[2].kind, "thinking.delta");
  assert.equal(writes[2].payload.text, "more");

  coalescer.flushAll();
  assert.equal(writes.length, 4);
  assert.equal(writes[3].kind, "text.delta");
  assert.equal(writes[3].payload.text, "world");
});

test("adjacent same-kind still merges across many micro deltas", () => {
  const { writes, coalescer } = collectWrites({ maxChars: 10_000 });
  coalescer.accept({ type: "thinking.delta", agent: "a", text: "a" });
  coalescer.accept({ type: "thinking.delta", agent: "a", text: "b" });
  coalescer.accept({ type: "thinking.delta", agent: "a", text: "c" });
  assert.equal(writes.length, 0);
  coalescer.accept({ type: "text.delta", agent: "a", text: "x" });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].payload.text, "abc");
  coalescer.flushAll();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].payload.text, "x");
});

test("A1: default maxMs is 0 — no idle timer on thinking monologue", () => {
  const timers = [];
  const { writes, coalescer } = collectWrites({
    maxChars: 10_000,
    // omit maxMs → DEFAULT_MAX_MS = 0
    schedule: (fn, ms) => {
      const id = { fn, ms, cancelled: false };
      timers.push(id);
      return id;
    },
    cancel: (handle) => {
      handle.cancelled = true;
    },
  });
  assert.equal(coalescer.maxMs, 0);
  assert.equal(coalescer.idleMsFor("thinking.delta"), 0);
  assert.equal(coalescer.idleMsFor("text.delta"), 0);

  coalescer.accept({ type: "thinking.delta", agent: "a", text: "chunk1 " });
  coalescer.accept({ type: "thinking.delta", agent: "a", text: "chunk2" });
  assert.equal(timers.length, 0, "idle disabled — no schedule calls");
  assert.equal(writes.length, 0);
  coalescer.flushAll();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].payload.text, "chunk1 chunk2");
});

test("A1: usage.update is passthrough and does not split thinking streak", () => {
  assert.ok(PASSTHROUGH_NO_FLUSH.has("usage.update"));
  const { writes, coalescer } = collectWrites({ maxChars: 10_000 });
  coalescer.accept({ type: "thinking.delta", agent: "a", text: "before " });
  coalescer.accept({
    type: "usage.update",
    agent: "a",
    scope: "run",
    mode: "cumulative",
    totalTokens: 100,
  });
  coalescer.accept({ type: "thinking.delta", agent: "a", text: "after" });
  assert.equal(writes.length, 1, "usage written immediately");
  assert.equal(writes[0].kind, "usage.update");
  assert.equal(coalescer.pendingChars("thinking.delta"), "before after".length);
  coalescer.flushAll();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].kind, "thinking.delta");
  assert.equal(writes[1].payload.text, "before after");
});

test("empty text.delta is ignored on durable path", () => {
  const { writes, coalescer } = collectWrites({ maxChars: 100 });
  coalescer.accept({ type: "text.delta", agent: "a", text: "" });
  coalescer.accept({ type: "text.delta", agent: "a", text: "hi" });
  coalescer.flushAll();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].payload.text, "hi");
});

test("disabled mode writes every event immediately", () => {
  const { writes, coalescer } = collectWrites({ enabled: false, maxChars: 400 });
  coalescer.accept({ type: "text.delta", agent: "a", text: "a" });
  coalescer.accept({ type: "text.delta", agent: "a", text: "b" });
  assert.equal(writes.length, 2);
  assert.equal(writes[0].payload.text, "a");
  assert.equal(writes[1].payload.text, "b");
});

test("maxChars 0 disables coalescing", () => {
  const { writes, coalescer } = collectWrites({ maxChars: 0 });
  assert.equal(coalescer.enabled, false);
  coalescer.accept({ type: "text.delta", agent: "a", text: "a" });
  assert.equal(writes.length, 1);
});

test("optional idle debounce still works when maxMs > 0", () => {
  let now = 0;
  const timers = [];
  const { writes, coalescer } = collectWrites({
    maxChars: 1000,
    maxMs: 50,
    now: () => now,
    schedule: (fn, ms) => {
      const id = { fn, fireAt: now + ms, cancelled: false };
      timers.push(id);
      return id;
    },
    cancel: (handle) => {
      handle.cancelled = true;
      const idx = timers.indexOf(handle);
      if (idx >= 0) timers.splice(idx, 1);
    },
  });

  coalescer.accept({ type: "text.delta", agent: "a", text: "tick" });
  assert.equal(timers.length, 1);
  const first = timers[0];

  // More text before idle fires — timer should be re-armed (debounce).
  now = 40;
  coalescer.accept({ type: "text.delta", agent: "a", text: " tock" });
  assert.equal(first.cancelled, true);
  assert.equal(timers.length, 1);
  assert.equal(writes.length, 0);

  now = 90;
  timers[0].fn();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].payload.text, "tick tock");
});

test("maxMsByKind overrides global maxMs per stream kind", () => {
  const timers = [];
  const { coalescer } = collectWrites({
    maxChars: 1000,
    maxMs: 100,
    maxMsByKind: { "thinking.delta": 0, "text.delta": 25 },
    schedule: (fn, ms) => {
      const id = { fn, ms };
      timers.push(id);
      return id;
    },
    cancel: () => {},
  });
  assert.equal(coalescer.idleMsFor("thinking.delta"), 0);
  assert.equal(coalescer.idleMsFor("text.delta"), 25);

  coalescer.accept({ type: "thinking.delta", agent: "a", text: "t" });
  assert.equal(timers.length, 0);
  coalescer.flushAll();

  coalescer.accept({ type: "text.delta", agent: "a", text: "x" });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 25);
  coalescer.flushAll();
});

test("resolveCoalesceOptionsFromEnv honors disable and numeric overrides", () => {
  assert.deepEqual(resolveCoalesceOptionsFromEnv({ DURABLE_DELTA_COALESCE: "0" }), {
    enabled: false,
  });
  assert.deepEqual(
    resolveCoalesceOptionsFromEnv({
      DURABLE_DELTA_COALESCE: "1",
      DURABLE_DELTA_COALESCE_CHARS: "80",
      DURABLE_DELTA_COALESCE_MS: "25",
    }),
    { enabled: true, maxChars: 80, maxMs: 25 }
  );
  assert.deepEqual(
    resolveCoalesceOptionsFromEnv({
      DURABLE_DELTA_COALESCE: "1",
      DURABLE_DELTA_COALESCE_MS_THINKING: "0",
      DURABLE_DELTA_COALESCE_MS_TEXT: "1500",
    }),
    {
      enabled: true,
      maxMsByKind: { "thinking.delta": 0, "text.delta": 1500 },
    }
  );
  // Unset env → only enabled; runtime uses DEFAULT_MAX_MS = 0 (A1).
  assert.deepEqual(resolveCoalesceOptionsFromEnv({ DURABLE_DELTA_COALESCE: "1" }), {
    enabled: true,
  });
  assert.equal(DEFAULT_MAX_CHARS, 8_000);
  assert.equal(DEFAULT_MAX_MS, 0);
});

const assert = require("node:assert/strict");
const test = require("node:test");

const handoff = require("../../src/agents/handoff");
const { createStorage } = require("../../src/storage");
const {
  MAX_MEMORY_CONTENT_CHARS,
  createMemoryCapture,
} = require("../../src/storage/memory-capture");

function createFixture() {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "thread-1" });
  storage.windows.create({
    id: "window-1",
    threadId: "thread-1",
    agentId: "codex",
    providerKey: "codex:test",
    workspaceKey: "base:C:/repo",
    generation: 1,
    capacityTokens: 200000,
  });
  storage.invocations.start({
    id: "invocation-1",
    threadId: "thread-1",
    windowId: "window-1",
    agentId: "codex",
  });
  return storage;
}

function createTranscript(events = []) {
  return {
    appendEvent(threadId, invocationId, kind, payload) {
      events.push({ threadId, invocationId, kind, payload });
    },
    flush: async () => {},
    listInvocations: async () => [...new Set(events.map((event) => event.invocationId))],
    readInvocation: async (_threadId, invocationId) =>
      events
        .filter((event) => event.invocationId === invocationId)
        .map((event) => ({ kind: event.kind, payload: event.payload })),
  };
}

function completeHandoff() {
  return {
    to: "opencode",
    goal: "实现登录流程",
    what: "已完成接口设计",
    why: "保持 API 兼容",
    next_action: "实现并测试",
    files: ["src/login.js"],
    evidence: ["tests pass"],
    open_questions: [],
  };
}

test("complete handoff is captured once and mirrored to the transcript", () => {
  const storage = createFixture();
  const events = [];
  try {
    const capture = createMemoryCapture({
      memoryService: storage.memory,
      transcript: createTranscript(events),
      idFactory: () => "memory-1",
    });
    const parsed = completeHandoff();
    const quality = handoff.evaluateHandoff(parsed);
    const first = capture.captureHandoff({
      threadId: "thread-1",
      invocationId: "invocation-1",
      windowId: "window-1",
      fromAgent: "codex",
      toAgent: "opencode",
      handoff: parsed,
      quality,
      blockIndex: 0,
    });
    const duplicate = capture.captureHandoff({
      threadId: "thread-1",
      invocationId: "invocation-1",
      windowId: "window-1",
      fromAgent: "codex",
      toAgent: "opencode",
      handoff: parsed,
      quality,
      blockIndex: 0,
    });

    assert.equal(first.persisted, true);
    assert.equal(first.event.captureKey, "handoff:invocation-1:opencode:0");
    assert.equal(duplicate.event.created, false);
    assert.equal(storage.memories.listForThread("thread-1").length, 1);
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, "memory-captured");
    assert.match(events[0].payload.content, /实现登录流程/);
    assert.equal(events[0].payload.metadata.quality.ok, true);
  } finally {
    storage.close();
  }
});

test("missing handoff block is a no-op", () => {
  const events = [];
  const capture = createMemoryCapture({ transcript: createTranscript(events) });
  const outcome = capture.captureHandoff({ quality: { hasBlock: false } });

  assert.deepEqual(outcome, { captured: false });
  assert.deepEqual(events, []);
});

test("invalid capture input is contained so routing can continue", () => {
  const errors = [];
  const capture = createMemoryCapture({
    transcript: createTranscript(),
    logger: {
      error(message) {
        errors.push(message);
      },
    },
  });
  const outcome = capture.captureHandoff({
    quality: { hasBlock: true },
    handoff: completeHandoff(),
  });

  assert.equal(outcome.captured, false);
  assert.match(outcome.error.message, /thread id is required/);
  assert.match(errors[0], /handoff capture failed/);
});

test("SQLite failure still leaves a replayable transcript event", () => {
  const events = [];
  const capture = createMemoryCapture({
    memoryService: {
      capture() {
        throw new Error("database offline");
      },
    },
    transcript: createTranscript(events),
    logger: { error() {} },
    idFactory: () => "memory-offline",
  });
  const parsed = completeHandoff();
  const outcome = capture.captureHandoff({
    threadId: "thread-1",
    invocationId: "invocation-1",
    fromAgent: "codex",
    toAgent: "opencode",
    handoff: parsed,
    quality: handoff.evaluateHandoff(parsed),
    blockIndex: 0,
  });

  assert.equal(outcome.persisted, false);
  assert.match(outcome.error.message, /database offline/);
  assert.equal(events[0].payload.persisted, false);
  assert.equal(events[0].payload.id, "memory-offline");
});

test("window seal captures a bounded partial snapshot", () => {
  const storage = createFixture();
  const events = [];
  try {
    const capture = createMemoryCapture({
      memoryService: storage.memory,
      transcript: createTranscript(events),
      idFactory: () => "seal-memory",
    });
    const outcome = capture.captureWindowSeal({
      threadId: "thread-1",
      invocationId: "invocation-1",
      windowId: "window-1",
      agentId: "codex",
      generation: 1,
      ratio: 0.92,
      assistantContent: `HEAD-${"x".repeat(4000)}-TAIL`,
    });

    assert.equal(outcome.memory.kind, "window-seal");
    assert.equal(outcome.memory.captureKey, "window-seal:window-1");
    assert.equal(outcome.memory.metadata.partial, true);
    assert.ok(outcome.memory.content.length <= MAX_MEMORY_CONTENT_CHARS);
    assert.match(outcome.memory.content, /HEAD-/);
    assert.match(outcome.memory.content, /-TAIL/);
    assert.equal(events[0].kind, "memory-captured");
  } finally {
    storage.close();
  }
});

test("replay restores transcript-only memory without stale foreign keys", async () => {
  const sourceEvents = [];
  const sourceCapture = createMemoryCapture({
    transcript: createTranscript(sourceEvents),
    idFactory: () => "replay-memory",
  });
  const parsed = completeHandoff();
  sourceCapture.captureHandoff({
    threadId: "thread-1",
    invocationId: "missing-invocation",
    windowId: "missing-window",
    fromAgent: "codex",
    toAgent: "opencode",
    handoff: parsed,
    quality: handoff.evaluateHandoff(parsed),
    blockIndex: 0,
  });

  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "thread-1" });
  try {
    const capture = createMemoryCapture({
      memoryService: storage.memory,
      transcript: createTranscript(sourceEvents),
      logger: { error() {} },
    });
    const outcome = await capture.replayThread("thread-1");
    const restored = storage.memories.get("replay-memory");

    assert.deepEqual(outcome, { replayed: 1, existing: 0, failed: 0, cached: false });
    assert.equal(restored.sourceInvocationId, null);
    assert.equal(restored.windowId, null);
    assert.equal(restored.metadata.replayedSourceInvocationId, "missing-invocation");
    assert.equal(restored.metadata.replayedWindowId, "missing-window");
    assert.equal((await capture.replayThread("thread-1")).cached, true);
  } finally {
    storage.close();
  }
});

test("disabled transcript replay never reads legacy memory events", async () => {
  let reads = 0;
  const capture = createMemoryCapture({
    memoryService: { capture() {} },
    eventStore: { append() {} },
    allowTranscriptReplay: false,
    transcript: {
      async listInvocations() {
        reads += 1;
        return ["legacy-invocation"];
      },
      async readInvocation() {
        reads += 1;
        return [];
      },
    },
  });

  assert.deepEqual(await capture.replayThread("thread-1"), {
    replayed: 0,
    existing: 0,
    failed: 0,
    available: false,
    reason: "transcript-replay-disabled",
  });
  assert.equal(reads, 0);
});

test("replay applies supersession in createdAt order even when invocations are listed reverse", async () => {
  const events = [
    {
      threadId: "thread-1",
      invocationId: "z-later",
      kind: "memory-captured",
      payload: {
        id: "memory-new",
        threadId: "thread-1",
        kind: "handoff",
        status: "captured",
        content: "Use signed cookies.",
        createdBy: "codex",
        createdAt: "2026-07-16T00:00:02.000Z",
        captureKey: "handoff:z-later:opencode:0",
        supersessionKey: "handoff:login",
        metadata: { quality: { ok: true } },
      },
    },
    {
      threadId: "thread-1",
      invocationId: "a-earlier",
      kind: "memory-captured",
      payload: {
        id: "memory-old",
        threadId: "thread-1",
        kind: "handoff",
        status: "captured",
        content: "Use plain cookies.",
        createdBy: "codex",
        createdAt: "2026-07-16T00:00:01.000Z",
        captureKey: "handoff:a-earlier:opencode:0",
        supersessionKey: "handoff:login",
        metadata: { quality: { ok: true } },
      },
    },
  ];
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "thread-1" });
  try {
    const capture = createMemoryCapture({
      memoryService: storage.memory,
      transcript: createTranscript(events),
      logger: { error() {} },
    });
    const outcome = await capture.replayThread("thread-1");

    assert.deepEqual(outcome, { replayed: 2, existing: 0, failed: 0, cached: false });
    assert.equal(storage.memories.get("memory-old").status, "superseded");
    assert.equal(storage.memories.get("memory-old").supersededBy, "memory-new");
    assert.equal(storage.memories.get("memory-new").status, "captured");
    assert.deepEqual(
      storage.memory.listActive("thread-1").map((memory) => memory.id),
      ["memory-new"]
    );
  } finally {
    storage.close();
  }
});

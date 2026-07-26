const assert = require("node:assert/strict");
const test = require("node:test");

const { createEventStore } = require("../../src/storage/event-store");
const { createStorage } = require("../../src/storage");

function seedInvocation(storage, { threadId = "thread-1", invocationId = "inv-1" } = {}) {
  storage.threads.create({ id: threadId, createdAt: "2026-07-12T00:00:00.000Z" });
  const window = storage.windows.create({
    id: "window-1",
    threadId,
    agentId: "codex",
    providerKey: "codex",
    workspaceKey: "base",
    generation: 1,
    capacityTokens: 1000,
    reserveRatio: 0.2,
  });
  storage.invocations.start({
    id: invocationId,
    threadId,
    windowId: window.id,
    agentId: "codex",
    startedAt: "2026-07-12T00:00:01.000Z",
  });
  return window;
}

test("event store writes SQLite recall and never writes transcripts directly", () => {
  const storage = createStorage({ file: ":memory:" });
  const transcriptEvents = [];
  seedInvocation(storage);
  const eventStore = createEventStore({
    storage,
    transcript: {
      appendEvent(threadId, invocationId, kind, payload) {
        transcriptEvents.push({ threadId, invocationId, kind, payload });
      },
    },
  });

  try {
    eventStore.registerInvocation("inv-1", "thread-1");
    const result = eventStore.append({
      threadId: "thread-1",
      invocationId: "inv-1",
      kind: "handoff",
      payload: { to: "gemini", goal: "ship" },
    });
    assert.equal(result.sqlite, true);
    assert.equal(storage.invocations.listEvents("inv-1").length, 1);
    assert.equal(storage.invocations.listEvents("inv-1")[0].kind, "handoff");
    assert.equal(transcriptEvents.length, 0);
    assert.equal(storage.recall.search("thread-1", "ship").length, 1);
  } finally {
    eventStore.close();
    storage.close();
  }
});

test("event store exposes a fixed sqlite-only contract", () => {
  const storage = createStorage({ file: ":memory:" });
  const transcriptEvents = [];
  seedInvocation(storage);
  const eventStore = createEventStore({
    storage,
    transcript: {
      appendEvent(threadId, invocationId, kind, payload) {
        transcriptEvents.push({ threadId, invocationId, kind, payload });
      },
    },
  });

  try {
    eventStore.registerInvocation("inv-1", "thread-1");
    const result = eventStore.append({
      threadId: "thread-1",
      invocationId: "inv-1",
      kind: "a2a-route",
      payload: { from: "codex", to: "gemini" },
    });
    assert.equal(result.sqlite, true);
    assert.equal(eventStore.mode, "sqlite");
    assert.equal(transcriptEvents.length, 0);
    assert.equal(storage.invocations.listEvents("inv-1")[0].kind, "a2a-route");
  } finally {
    eventStore.close();
    storage.close();
  }
});

test("event store rejects synthetic invocation ids", () => {
  const storage = createStorage({ file: ":memory:" });
  const transcriptEvents = [];
  const eventStore = createEventStore({
    storage,
    transcript: {
      appendEvent(threadId, invocationId, kind, payload) {
        transcriptEvents.push({ threadId, invocationId, kind, payload });
      },
    },
  });

  try {
    const result = eventStore.append({
      threadId: "thread-1",
      invocationId: "_user_prompt",
      kind: "user-prompt",
      payload: { content: "hi" },
    });
    assert.equal(result.sqlite, false);
    assert.equal(result.ok, false);
    assert.equal(transcriptEvents.length, 0);
  } finally {
    eventStore.close();
    storage.close();
  }
});

test("event store propagates SQLite write failures so outer transactions roll back", () => {
  const storage = createStorage({ file: ":memory:" });
  seedInvocation(storage);
  const originalUpsert = storage.recall.upsert.bind(storage.recall);
  storage.recall.upsert = () => {
    throw new Error("recall projection failed");
  };
  const eventStore = createEventStore({ storage });

  try {
    eventStore.registerInvocation("inv-1", "thread-1");
    assert.throws(
      () =>
        storage.transaction(() => {
          storage.invocations.finish("inv-1", {
            state: "completed",
            exitCode: 0,
            signal: null,
          });
          eventStore.append({
            threadId: "thread-1",
            invocationId: "inv-1",
            kind: "invocation-end",
            payload: { code: 0, signal: null },
          });
        }),
      /recall projection failed/
    );
    // Finish + event must roll back together.
    assert.equal(storage.invocations.get("inv-1").state, "active");
    assert.equal(storage.invocations.listEvents("inv-1").length, 0);
  } finally {
    storage.recall.upsert = originalUpsert;
    eventStore.close();
    storage.close();
  }
});

test("sqlite audit transcript can be disabled without disabling authoritative events", () => {
  const storage = createStorage({ file: ":memory:" });
  seedInvocation(storage);
  const eventStore = createEventStore({
    storage,
    auditTranscript: false,
  });

  try {
    const result = eventStore.append({
      threadId: "thread-1",
      invocationId: "inv-1",
      kind: "text.delta",
      payload: { text: "SQLite remains authoritative" },
    });
    assert.equal(result.sqlite, true);
    assert.equal(result.outbox, false);
    assert.equal(eventStore.archiveCanonical, false);
    assert.equal(storage.invocations.listEvents("inv-1").length, 1);
    assert.equal(storage.outbox.listPending().length, 0);
  } finally {
    eventStore.close();
    storage.close();
  }
});

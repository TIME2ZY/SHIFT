const assert = require("node:assert/strict");
const test = require("node:test");

const { createStorage } = require("../../src/storage");

function seedThread(storage, id = "thread-1") {
  storage.threads.upsert({
    id,
    title: "Trace",
    projectDir: "C:/repo",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  });
  return storage.windows.create({
    id: `${id}-window`,
    threadId: id,
    agentId: "codex",
    providerKey: "codex:gpt",
    workspaceKey: "base:C:/repo",
    generation: 1,
    capacityTokens: 1000,
  });
}

test("trace repository allocates request attempts and rejects completion with active invocations", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    const window = seedThread(storage);
    const first = storage.traces.start({
      threadId: "thread-1",
      clientTurnId: "turn-1",
      startedAt: "2026-08-12T00:00:01.000Z",
    });
    const second = storage.traces.start({
      threadId: "thread-1",
      clientTurnId: "turn-1",
      startedAt: "2026-08-12T00:00:02.000Z",
    });
    assert.equal(first.requestAttempt, 1);
    assert.equal(second.requestAttempt, 2);

    storage.invocations.start({
      id: "invocation-1",
      threadId: "thread-1",
      windowId: window.id,
      agentId: "codex",
      traceId: first.id,
    });
    storage.traces.bindRootInvocation(first.id, "invocation-1");
    assert.throws(
      () => storage.traces.finish(first.id, { state: "completed" }),
      /active invocation/
    );
    storage.invocations.finish("invocation-1", {
      state: "completed",
      exitCode: 0,
      terminalReason: "assistant-final",
    });
    storage.messages.append({
      id: "assistant-1",
      threadId: "thread-1",
      windowId: window.id,
      invocationId: "invocation-1",
      role: "assistant",
      content: "done",
      messageType: "assistant-final",
    });
    const completed = storage.traces.finish(first.id, {
      state: "completed",
      terminalReason: "request-completed",
    });
    assert.equal(completed.rootInvocationId, "invocation-1");
    assert.equal(completed.state, "completed");
  } finally {
    storage.close();
  }
});

test("completed trace requires a successful invocation and assistant-final", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    seedThread(storage);
    const trace = storage.traces.start({ threadId: "thread-1" });
    assert.throws(
      () => storage.traces.finish(trace.id, { state: "completed" }),
      /successful invocation/
    );
  } finally {
    storage.close();
  }
});

test("invocation trace causality is restricted to the owning thread", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    seedThread(storage, "thread-1");
    const otherWindow = seedThread(storage, "thread-2");
    const trace = storage.traces.start({ threadId: "thread-1" });
    assert.throws(
      () =>
        storage.invocations.start({
          id: "cross-thread-invocation",
          threadId: "thread-2",
          windowId: otherWindow.id,
          agentId: "codex",
          traceId: trace.id,
        }),
      /belongs to another thread/
    );
  } finally {
    storage.close();
  }
});

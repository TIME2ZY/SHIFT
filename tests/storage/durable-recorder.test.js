const assert = require("node:assert/strict");
const test = require("node:test");

const { createDurableRecorder } = require("../../src/storage/durable-recorder");
const { createStorage } = require("../../src/storage");

function sessionFixture() {
  return {
    id: "thread-1",
    title: "Dual write",
    projectDir: "C:/repo",
    lastAgent: "codex",
    createdAt: "2026-07-12T00:00:00.000Z",
    messages: [],
  };
}

test("durable recorder writes thread, window, message, and invocation data", () => {
  const storage = createStorage({ file: ":memory:" });
  const recorder = createDurableRecorder({ storage });
  const session = sessionFixture();
  try {
    const window = recorder.ensureWindow({
      session,
      threadId: session.id,
      agentId: "codex",
      providerKey: "codex:gpt-5.6-sol",
      workspaceKey: "base:C:/repo",
      capacityTokens: 200000,
    });
    session.messages.push({
      id: "message-user",
      role: "user",
      agent: "codex",
      content: "Remember this",
      createdAt: "2026-07-12T00:00:01.000Z",
    });
    recorder.mirrorLastMessage(session, { windowId: window.id });

    const run = recorder.startInvocation({
      session,
      invocationId: "invocation-1",
      threadId: session.id,
      agentId: "codex",
      providerKey: "codex:gpt-5.6-sol",
      workspaceKey: "base:C:/repo",
      capacityTokens: 200000,
      resumeSessionId: "provider-session-1",
      startedAt: "2026-07-12T00:00:02.000Z",
      triggerMessageId: "message-user",
      triggerType: "user-message",
    });
    recorder.appendInvocationEvent("invocation-1", "text.delta", { text: "Stored" });
    session.messages.push({
      id: "message-assistant",
      role: "assistant",
      agent: "codex",
      content: "Stored",
      invocationId: "invocation-1",
      createdAt: "2026-07-12T00:00:03.000Z",
    });
    recorder.mirrorLastMessage(session, { invocationId: "invocation-1" });
    recorder.finishInvocation("invocation-1", 0, null);

    assert.equal(storage.invocations.get("invocation-1").triggerMessageId, "message-user");
    assert.equal(storage.invocations.get("invocation-1").triggerType, "user-message");

    assert.equal(run.window.id, window.id);
    assert.equal(storage.threads.get("thread-1").lastAgentId, "codex");
    assert.equal(storage.windows.listForThread("thread-1").length, 1);
    recorder.addWindowUsage(window.id, { inputChars: 100, outputChars: 50 });
    assert.equal(storage.windows.get(window.id).providerSessionId, "provider-session-1");
    assert.equal(storage.windows.get(window.id).inputChars, 100);
    assert.equal(storage.windows.get(window.id).outputChars, 50);
    assert.equal(storage.messages.listForThread("thread-1").length, 2);
    assert.equal(storage.messages.get("message-assistant").windowId, window.id);
    assert.equal(storage.invocations.get("invocation-1").state, "completed");
    assert.deepEqual(
      storage.invocations.listEvents("invocation-1").map((event) => event.kind),
      ["invocation-start", "text.delta", "invocation-end"]
    );
    assert.equal(storage.recall.search("thread-1", "Remember this")[0].sourceKind, "message");
    assert.equal(
      storage.recall.search("thread-1", "Stored", { sourceKinds: ["invocation-event"] }).length,
      1
    );
  } finally {
    recorder.close();
    storage.close();
  }
});

test("finishWithAssistantMessage writes finish event and final message atomically", () => {
  const storage = createStorage({ file: ":memory:" });
  const recorder = createDurableRecorder({ storage });
  const session = sessionFixture();
  try {
    session.messages.push({
      id: "message-user",
      role: "user",
      agent: "codex",
      content: "go",
      createdAt: "2026-07-12T00:00:01.000Z",
    });
    recorder.mirrorLastMessage(session);
    recorder.startInvocation({
      session,
      invocationId: "invocation-atomic",
      threadId: session.id,
      agentId: "codex",
      providerKey: "codex:gpt-5.6-sol",
      workspaceKey: "base:C:/repo",
      capacityTokens: 200000,
      startedAt: "2026-07-12T00:00:02.000Z",
      triggerMessageId: "message-user",
      triggerType: "user-message",
    });

    const originalUpsert = storage.recall.upsert.bind(storage.recall);
    let messageRecallCalls = 0;
    storage.recall.upsert = (item) => {
      if (item.sourceKind === "message") {
        messageRecallCalls += 1;
        if (messageRecallCalls === 1) throw new Error("message recall failed");
      }
      return originalUpsert(item);
    };

    assert.throws(
      () =>
        recorder.finishWithAssistantMessage({
          invocationId: "invocation-atomic",
          code: 0,
          signal: null,
          session,
          message: {
            id: "message-assistant",
            role: "assistant",
            agent: "codex",
            content: "done",
            createdAt: "2026-07-12T00:00:03.000Z",
          },
        }),
      /message recall failed/
    );
    assert.equal(storage.invocations.get("invocation-atomic").state, "failed");
    assert.equal(storage.messages.get("message-assistant"), null);
    assert.deepEqual(
      storage.invocations.listEvents("invocation-atomic").map((event) => event.kind),
      ["invocation-start", "invocation-end"]
    );

    storage.recall.upsert = originalUpsert;
    recorder.startInvocation({
      session,
      invocationId: "invocation-atomic-success",
      threadId: session.id,
      agentId: "codex",
      providerKey: "codex:gpt-5.6-sol",
      workspaceKey: "base:C:/repo",
      capacityTokens: 200000,
      startedAt: "2026-07-12T00:00:04.000Z",
      triggerMessageId: "message-user",
      triggerType: "user-message",
    });
    const completed = recorder.finishWithAssistantMessage({
      invocationId: "invocation-atomic-success",
      code: 0,
      signal: null,
      session,
      message: {
        id: "message-assistant",
        role: "assistant",
        agent: "codex",
        content: "done",
        createdAt: "2026-07-12T00:00:05.000Z",
      },
    });
    assert.equal(completed.invocation.state, "completed");
    assert.equal(completed.message.id, "message-assistant");
    assert.deepEqual(
      storage.invocations.listEvents("invocation-atomic").map((event) => event.kind),
      ["invocation-start", "invocation-end"]
    );
    assert.deepEqual(
      storage.invocations.listEvents("invocation-atomic-success").map((event) => event.kind),
      ["invocation-start", "invocation-end"]
    );
    // Assistant must not rewrite the user-chosen lastAgent.
    assert.equal(storage.threads.get("thread-1").lastAgentId, "codex");
  } finally {
    recorder.close();
    storage.close();
  }
});

test("durable write failures are reported and fail closed", () => {
  const errors = [];
  const storage = createStorage({ file: ":memory:" });
  const recorder = createDurableRecorder({
    storage,
    logger: { error: (message) => errors.push(message) },
  });

  storage.threads.upsert = () => {
    throw new Error("database unavailable");
  };
  storage.threads.delete = () => {
    throw new Error("database unavailable");
  };
  assert.throws(() => recorder.mirrorThread(sessionFixture()), /database unavailable/);
  assert.throws(() => recorder.archiveThread("thread-1"), /database unavailable/);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /mirror thread failed: database unavailable/);
  recorder.close();
  storage.close();
});

test("deleting a thread suppresses late writes from its active invocation", () => {
  const storage = createStorage({ file: ":memory:" });
  const errors = [];
  const recorder = createDurableRecorder({
    storage,
    logger: { error: (message) => errors.push(message) },
  });
  const session = sessionFixture();
  try {
    recorder.startInvocation({
      session,
      invocationId: "invocation-1",
      threadId: session.id,
      agentId: "codex",
      providerKey: "codex:gpt-5.6-sol",
      workspaceKey: "base:C:/repo",
      capacityTokens: 200000,
    });

    assert.equal(recorder.archiveThread(session.id), true);
    assert.equal(
      recorder.appendInvocationEvent("invocation-1", "text.delta", { text: "late" }),
      false
    );
    assert.equal(recorder.finishInvocation("invocation-1", 0, null), null);
    assert.equal(errors.length, 0);
  } finally {
    recorder.close();
    storage.close();
  }
});

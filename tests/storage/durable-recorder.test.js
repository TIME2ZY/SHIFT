const assert = require("node:assert/strict");
const test = require("node:test");

const { createDurableRecorder } = require("../../src/storage/durable-recorder");
const { createStorage } = require("../../src/storage");
const { appendMessage } = require("../../src/storage/message-persistence");

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
    appendMessage(storage, {
      id: "message-user",
      threadId: session.id,
      windowId: window.id,
      role: "user",
      agentId: "codex",
      content: "Remember this",
      createdAt: "2026-07-12T00:00:01.000Z",
    });

    const trace = recorder.startTrace({
      threadId: session.id,
      clientTurnId: "turn-1",
      startedAt: "2026-07-12T00:00:01.500Z",
    });

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
      traceId: trace.id,
    });
    recorder.appendInvocationEvent("invocation-1", "text.delta", { text: "Stored" });
    // Assistant-final goes only through completeInvocation (not mirror + finish*).
    const finished = recorder.completeInvocation({
      invocationId: "invocation-1",
      code: 0,
      signal: null,
      reason: "assistant-final",
      session,
      windowId: window.id,
      message: {
        id: "message-assistant",
        role: "assistant",
        agent: "codex",
        content: "Stored",
        createdAt: "2026-07-12T00:00:03.000Z",
      },
    });

    assert.equal(finished.message.id, "message-assistant");
    assert.equal(storage.invocations.get("invocation-1").triggerMessageId, "message-user");
    assert.equal(storage.invocations.get("invocation-1").triggerType, "user-message");
    assert.equal(storage.invocations.get("invocation-1").traceId, trace.id);
    assert.equal(storage.traces.get(trace.id).rootInvocationId, "invocation-1");

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
    assert.equal(storage.invocations.get("invocation-1").terminalReason, "assistant-final");
    assert.equal(storage.invocations.get("invocation-1").failureStage, null);
    assert.equal(
      recorder.completeTrace({
        traceId: trace.id,
        state: "completed",
        terminalReason: "request-completed",
      }).state,
      "completed"
    );
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

/**
 * Single suite for the public terminal API (completeInvocation only).
 * Old finishInvocation / finishWithAssistantMessage tests were deleted, not renamed+kept.
 */
test("completeInvocation covers abort, final, atomic rollback, and rejects missing ids", () => {
  const storage = createStorage({ file: ":memory:" });
  const recorder = createDurableRecorder({ storage });
  const session = sessionFixture();
  try {
    assert.equal(typeof recorder.completeInvocation, "function");
    assert.equal(recorder.finishInvocation, undefined);
    assert.equal(recorder.finishWithAssistantMessage, undefined);

    session.messages.push({
      id: "message-user",
      role: "user",
      agent: "codex",
      content: "go",
      createdAt: "2026-07-12T00:00:01.000Z",
    });
    recorder.ensureWindow({
      session,
      threadId: session.id,
      agentId: "codex",
      providerKey: "codex:gpt-5.6-sol",
      workspaceKey: "base:C:/repo",
      capacityTokens: 200000,
    });
    appendMessage(storage, {
      id: "message-user",
      threadId: session.id,
      role: "user",
      agentId: "codex",
      content: "go",
      createdAt: "2026-07-12T00:00:01.000Z",
    });

    recorder.startInvocation({
      session,
      invocationId: "inv-abort",
      threadId: session.id,
      agentId: "codex",
      providerKey: "codex:gpt-5.6-sol",
      workspaceKey: "base:C:/repo",
      capacityTokens: 200000,
      startedAt: "2026-07-12T00:00:02.000Z",
      triggerMessageId: "message-user",
      triggerType: "user-message",
    });
    const aborted = recorder.completeInvocation({
      invocationId: "inv-abort",
      code: null,
      signal: "SIGTERM",
      reason: "aborted",
      endPayload: { terminalState: "aborted", agent: "codex" },
    });
    assert.equal(aborted.reason, "aborted");
    assert.equal(aborted.message, null);
    assert.equal(aborted.invocation.state, "aborted");
    assert.equal(aborted.invocation.terminalReason, "aborted");
    assert.equal(aborted.invocation.failureStage, "request");
    assert.equal(aborted.invocation.errorCode, "invocation_aborted");
    assert.equal(aborted.invocation.retryable, false);
    assert.equal(storage.messages.listForThread("thread-1").length, 1);

    recorder.startInvocation({
      session,
      invocationId: "inv-provider-fail",
      threadId: session.id,
      agentId: "codex",
      providerKey: "codex:gpt-5.6-sol",
      workspaceKey: "base:C:/repo",
      capacityTokens: 200000,
    });
    const failed = recorder.completeInvocation({
      invocationId: "inv-provider-fail",
      code: 7,
      signal: null,
      reason: "provider-failed",
    });
    assert.equal(failed.invocation.state, "failed");
    assert.equal(failed.invocation.terminalReason, "provider-failed");
    assert.equal(failed.invocation.failureStage, "provider_run");
    assert.equal(failed.invocation.errorCode, "provider_exit_7");
    assert.equal(failed.invocation.retryable, false);

    recorder.startInvocation({
      session,
      invocationId: "inv-atomic-fail",
      threadId: session.id,
      agentId: "codex",
      providerKey: "codex:gpt-5.6-sol",
      workspaceKey: "base:C:/repo",
      capacityTokens: 200000,
      startedAt: "2026-07-12T00:00:03.000Z",
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
        recorder.completeInvocation({
          invocationId: "inv-atomic-fail",
          code: 0,
          signal: null,
          session,
          message: {
            id: "message-assistant-fail",
            role: "assistant",
            agent: "codex",
            content: "done",
            createdAt: "2026-07-12T00:00:04.000Z",
          },
        }),
      /message recall failed/
    );
    assert.equal(storage.invocations.get("inv-atomic-fail").state, "failed");
    assert.equal(storage.messages.get("message-assistant-fail"), null);
    assert.deepEqual(
      storage.invocations.listEvents("inv-atomic-fail").map((event) => event.kind),
      ["invocation-start", "invocation-end"]
    );

    storage.recall.upsert = originalUpsert;
    recorder.startInvocation({
      session,
      invocationId: "inv-final",
      threadId: session.id,
      agentId: "codex",
      providerKey: "codex:gpt-5.6-sol",
      workspaceKey: "base:C:/repo",
      capacityTokens: 200000,
      startedAt: "2026-07-12T00:00:05.000Z",
      triggerMessageId: "message-user",
      triggerType: "user-message",
    });
    const completed = recorder.completeInvocation({
      invocationId: "inv-final",
      code: 0,
      signal: null,
      reason: "assistant-final",
      session,
      message: {
        id: "message-assistant-ok",
        role: "assistant",
        agent: "codex",
        content: "done",
        createdAt: "2026-07-12T00:00:06.000Z",
      },
    });
    assert.equal(completed.reason, "assistant-final");
    assert.equal(completed.invocation.state, "completed");
    assert.equal(completed.message.id, "message-assistant-ok");
    assert.deepEqual(
      storage.invocations.listEvents("inv-final").map((event) => event.kind),
      ["invocation-start", "invocation-end"]
    );
    assert.equal(storage.threads.get("thread-1").lastAgentId, "codex");

    assert.equal(recorder.completeInvocation({}), null);
    assert.equal(recorder.completeInvocation({ invocationId: "missing" }), null);
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
  storage.threads.archive = () => {
    throw new Error("database unavailable");
  };
  assert.throws(
    () =>
      recorder.ensureWindow({
        session: sessionFixture(),
        threadId: "thread-1",
        agentId: "codex",
        providerKey: "codex:gpt-5.6-sol",
        workspaceKey: "base:C:/repo",
        capacityTokens: 200000,
      }),
    /database unavailable/
  );
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
    assert.equal(
      recorder.completeInvocation({ invocationId: "invocation-1", code: 0, signal: null }),
      null
    );
    assert.equal(errors.length, 0);
  } finally {
    recorder.close();
    storage.close();
  }
});

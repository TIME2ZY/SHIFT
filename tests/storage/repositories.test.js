const assert = require("node:assert/strict");
const test = require("node:test");

const { createStorage } = require("../../src/storage");

function createFixture() {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "thread-1", title: "Memory work" });
  const window = storage.windows.create({
    id: "window-1",
    threadId: "thread-1",
    agentId: "codex",
    providerKey: "codex:gpt-5.6-sol",
    workspaceKey: "base:C:/repo",
    generation: 1,
    capacityTokens: 200000,
  });
  return { storage, window };
}

test("repositories persist a complete invocation record", () => {
  const { storage, window } = createFixture();
  try {
    assert.equal(window.state, "active");
    assert.equal(window.generation, 1);
    assert.equal(storage.windows.bindProviderSession("window-1", "provider-session-1"), true);
    assert.equal(storage.windows.addUsage("window-1", { inputChars: 120, outputChars: 80 }), true);

    storage.invocations.start({
      id: "invocation-1",
      threadId: "thread-1",
      windowId: "window-1",
      agentId: "codex",
    });
    storage.invocations.appendEvent({
      invocationId: "invocation-1",
      sequenceNo: 0,
      kind: "run.started",
      payload: { agent: "codex" },
    });
    storage.invocations.appendEvent({
      invocationId: "invocation-1",
      sequenceNo: 1,
      kind: "text.delta",
      payload: { text: "hello" },
    });
    storage.messages.append({
      id: "message-1",
      threadId: "thread-1",
      windowId: "window-1",
      invocationId: "invocation-1",
      sequenceNo: 0,
      role: "assistant",
      agentId: "codex",
      content: "hello",
      metadata: { source: "stream" },
    });

    const finished = storage.invocations.finish("invocation-1", {
      state: "completed",
      exitCode: 0,
    });
    assert.equal(finished.state, "completed");
    assert.equal(storage.invocations.listEvents("invocation-1").length, 2);
    const storedMessage = storage.messages.get("message-1");
    assert.deepEqual(storedMessage.metadata, { source: "stream" });
    assert.equal(storedMessage.messageType, "assistant-final");
    assert.equal(storage.invocations.get("invocation-1").nextEventSequence, 2);
    assert.equal(storage.threads.get("thread-1").nextMessageSequence, 1);
    const updatedWindow = storage.windows.get("window-1");
    assert.equal(updatedWindow.providerSessionId, "provider-session-1");
    assert.equal(updatedWindow.inputChars, 120);
    assert.equal(updatedWindow.outputChars, 80);
  } finally {
    storage.close();
  }
});

test("message repository allocates durable sequences and classifies message types", () => {
  const { storage } = createFixture();
  try {
    const user = storage.messages.append({
      id: "message-user",
      threadId: "thread-1",
      role: "user",
      agentId: "codex",
      content: "hello",
    });
    const route = storage.messages.append({
      id: "message-route",
      threadId: "thread-1",
      role: "system",
      content: "Codex → Gemini",
      metadata: { kind: "a2a-route" },
    });
    const phaseRejected = storage.messages.append({
      id: "message-phase-rejected",
      threadId: "thread-1",
      role: "system",
      messageType: "a2a-phase-rejected",
      content: "Gemini → Codex rejected by phase policy",
      metadata: { kind: "a2a-skipped" },
    });
    const imported = storage.messages.append({
      id: "message-imported",
      threadId: "thread-1",
      sequenceNo: 7,
      role: "assistant",
      content: "imported",
      metadata: { source: "callback" },
    });
    const next = storage.messages.append({
      id: "message-next",
      threadId: "thread-1",
      role: "assistant",
      content: "next",
    });

    assert.deepEqual(
      [user, route, phaseRejected, imported, next].map((message) => [
        message.sequenceNo,
        message.messageType,
      ]),
      [
        [0, "user"],
        [1, "a2a-route"],
        [2, "a2a-phase-rejected"],
        [7, "assistant-callback"],
        [8, "assistant-final"],
      ]
    );
    assert.equal(storage.threads.get("thread-1").nextMessageSequence, 9);
    assert.equal(
      storage.messages.append({
        id: "message-next",
        threadId: "thread-1",
        role: "assistant",
        content: "ignored replay",
      }).sequenceNo,
      8
    );
    assert.throws(
      () =>
        storage.messages.append({
          id: "bad-message",
          threadId: "thread-1",
          role: "assistant",
          messageType: "unknown",
          content: "bad",
        }),
      /Unsupported message type/
    );
    assert.throws(
      () =>
        storage.messages.append({
          id: "bad-role-message",
          threadId: "thread-1",
          role: "user",
          messageType: "assistant-final",
          content: "bad",
        }),
      /not valid for role/
    );
  } finally {
    storage.close();
  }
});

test("message repository enforces one user message per client turn id", () => {
  const { storage } = createFixture();
  try {
    const first = storage.messages.append({
      id: "turn-message-1",
      threadId: "thread-1",
      role: "user",
      content: "repeat me",
      clientTurnId: "turn-1",
    });
    const intentionalRepeat = storage.messages.append({
      id: "turn-message-2",
      threadId: "thread-1",
      role: "user",
      content: "repeat me",
      clientTurnId: "turn-2",
    });

    assert.equal(first.clientTurnId, "turn-1");
    assert.equal(intentionalRepeat.clientTurnId, "turn-2");
    assert.equal(storage.messages.findUserByClientTurnId("thread-1", "turn-1").id, first.id);
    assert.throws(
      () =>
        storage.messages.append({
          id: "turn-message-duplicate",
          threadId: "thread-1",
          role: "user",
          content: "different content",
          clientTurnId: "turn-1",
        }),
      /UNIQUE constraint failed/
    );
  } finally {
    storage.close();
  }
});

test("message repository allows callbacks but enforces one final per invocation", () => {
  const { storage, window } = createFixture();
  try {
    storage.invocations.start({
      id: "invocation-1",
      threadId: "thread-1",
      windowId: window.id,
      agentId: "codex",
    });
    storage.messages.append({
      id: "callback-message",
      threadId: "thread-1",
      invocationId: "invocation-1",
      role: "assistant",
      messageType: "assistant-callback",
      content: "progress",
    });
    storage.messages.append({
      id: "final-message",
      threadId: "thread-1",
      invocationId: "invocation-1",
      role: "assistant",
      content: "done",
    });

    assert.throws(
      () =>
        storage.messages.append({
          id: "second-final",
          threadId: "thread-1",
          invocationId: "invocation-1",
          role: "assistant",
          content: "duplicate",
        }),
      /UNIQUE constraint failed/
    );
    assert.equal(storage.threads.get("thread-1").nextMessageSequence, 2);
  } finally {
    storage.close();
  }
});

test("invocation repository allocates event sequences and preserves causal links", () => {
  const { storage, window } = createFixture();
  try {
    const trigger = storage.messages.append({
      id: "trigger-message",
      threadId: "thread-1",
      role: "user",
      content: "start",
    });
    const parent = storage.invocations.start({
      id: "parent-invocation",
      threadId: "thread-1",
      windowId: window.id,
      agentId: "codex",
      triggerMessageId: trigger.id,
      triggerType: "user-message",
    });
    storage.invocations.appendEvent({
      invocationId: parent.id,
      sequenceNo: 4,
      kind: "imported",
    });
    const nextEvent = storage.invocations.appendEvent({
      invocationId: parent.id,
      kind: "text.delta",
      payload: { text: "hello" },
    });
    const child = storage.invocations.start({
      id: "child-invocation",
      threadId: "thread-1",
      windowId: window.id,
      agentId: "gemini",
      parentInvocationId: parent.id,
      triggerMessageId: trigger.id,
      triggerType: "a2a-handoff",
    });

    assert.equal(nextEvent.sequenceNo, 5);
    assert.equal(storage.invocations.get(parent.id).nextEventSequence, 6);
    assert.equal(child.parentInvocationId, parent.id);
    assert.equal(child.triggerMessageId, trigger.id);
    assert.equal(child.triggerType, "a2a-handoff");
  } finally {
    storage.close();
  }
});

test("invocation causal references must stay inside their thread", () => {
  const { storage, window } = createFixture();
  try {
    storage.threads.create({ id: "thread-2" });
    const otherWindow = storage.windows.create({
      id: "window-2",
      threadId: "thread-2",
      agentId: "codex",
      providerKey: "codex:gpt-5.6-sol",
      workspaceKey: "base:C:/repo",
      generation: 1,
      capacityTokens: 200000,
    });
    const otherMessage = storage.messages.append({
      id: "other-message",
      threadId: "thread-2",
      role: "user",
      content: "other",
    });
    const otherInvocation = storage.invocations.start({
      id: "other-invocation",
      threadId: "thread-2",
      windowId: otherWindow.id,
      agentId: "codex",
    });

    assert.throws(
      () =>
        storage.invocations.start({
          id: "bad-parent",
          threadId: "thread-1",
          windowId: window.id,
          agentId: "codex",
          parentInvocationId: otherInvocation.id,
        }),
      /belongs to another thread/
    );
    assert.throws(
      () =>
        storage.invocations.start({
          id: "bad-trigger",
          threadId: "thread-1",
          windowId: window.id,
          agentId: "codex",
          triggerMessageId: otherMessage.id,
          triggerType: "user-message",
        }),
      /belongs to another thread/
    );
  } finally {
    storage.close();
  }
});

test("message repository preserves an empty assistant result", () => {
  const { storage } = createFixture();
  try {
    const message = storage.messages.append({
      id: "message-empty",
      threadId: "thread-1",
      windowId: "window-1",
      sequenceNo: 0,
      role: "assistant",
      content: "",
    });
    assert.equal(message.content, "");
  } finally {
    storage.close();
  }
});

test("only one open window is allowed per agent provider workspace coordinate", () => {
  const { storage } = createFixture();
  try {
    assert.throws(
      () =>
        storage.windows.create({
          id: "window-2",
          threadId: "thread-1",
          agentId: "codex",
          providerKey: "codex:gpt-5.6-sol",
          workspaceKey: "base:C:/repo",
          generation: 2,
          capacityTokens: 200000,
        }),
      /UNIQUE constraint failed/
    );
  } finally {
    storage.close();
  }
});

test("memory candidates preserve provenance and default to active", () => {
  const { storage } = createFixture();
  try {
    storage.invocations.start({
      id: "invocation-1",
      threadId: "thread-1",
      windowId: "window-1",
      agentId: "codex",
    });
    storage.messages.append({
      id: "message-1",
      threadId: "thread-1",
      windowId: "window-1",
      invocationId: "invocation-1",
      sequenceNo: 0,
      role: "assistant",
      content: "Use SQLite as the durable store.",
    });
    const memory = storage.memories.create({
      id: "memory-1",
      threadId: "thread-1",
      kind: "decision",
      content: "Use SQLite as the durable store.",
      sourceMessageId: "message-1",
      sourceInvocationId: "invocation-1",
      createdBy: "codex",
    });

    assert.equal(memory.status, "active");
    assert.equal(memory.sourceMessageId, "message-1");
    assert.throws(
      () => storage.memories.transition("memory-1", "confirmed"),
      /CHECK constraint failed/
    );
    assert.equal(storage.memories.get("memory-1").status, "active");
  } finally {
    storage.close();
  }
});

test("purging a thread cascades through thread-owned durable memory records", () => {
  const { storage } = createFixture();
  try {
    storage.invocations.start({
      id: "invocation-1",
      threadId: "thread-1",
      windowId: "window-1",
      agentId: "codex",
    });
    storage.invocations.appendEvent({
      invocationId: "invocation-1",
      sequenceNo: 0,
      kind: "run.started",
    });
    storage.memories.create({
      id: "memory-1",
      threadId: "thread-1",
      kind: "fact",
      content: "Keep raw evidence.",
      sourceInvocationId: "invocation-1",
      createdBy: "codex",
      captureKey: "fact:evidence:1",
    });

    // Default delete is archive (soft); purge hard-deletes thread-owned rows.
    assert.equal(storage.threads.purge("thread-1"), true);
    assert.equal(
      storage.db.prepare("SELECT COUNT(*) AS count FROM context_windows").get().count,
      0
    );
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM invocations").get().count, 0);
    assert.equal(
      storage.db.prepare("SELECT COUNT(*) AS count FROM invocation_events").get().count,
      0
    );
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM memory_entries").get().count, 0);
  } finally {
    storage.close();
  }
});

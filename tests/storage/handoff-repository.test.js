const assert = require("node:assert/strict");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const { createDurableRecorder } = require("../../src/storage/durable-recorder");

function seed(storage, threadId, traceId, invocationId) {
  storage.threads.upsert({ id: threadId, title: "Handoff", projectDir: "C:/repo" });
  const window = storage.windows.create({
    id: `${threadId}-window`, threadId, agentId: "codex", providerKey: "codex:gpt",
    workspaceKey: "base:C:/repo", generation: 1, capacityTokens: 1000,
  });
  storage.traces.start({ id: traceId, threadId });
  storage.invocations.start({
    id: invocationId, threadId, traceId, windowId: window.id, agentId: "codex",
  });
  return window;
}

test("durable handoff deduplicates accepted routes across repository instances", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    seed(storage, "thread-1", "trace-1", "source-1");
    const input = {
      sourceInvocationId: "source-1", sourceAgentId: "codex", targetAgentId: "grok",
      contentHash: "content-1", parseStatus: "parsed",
    };
    const first = storage.handoffs.accept(input);
    const duplicate = storage.handoffs.accept(input);
    assert.equal(first.accepted, true);
    assert.equal(duplicate.accepted, false);
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.record.duplicateOf, first.record.handoffId);
    assert.equal(duplicate.record.completeStatus, "failed");
    assert.equal(duplicate.record.failureStage, "handoff_route");
    assert.ok(duplicate.record.completedAt);
  } finally {
    storage.close();
  }
});

test("target invocation bind and terminal handoff commit through durable recorder", () => {
  const storage = createStorage({ file: ":memory:" });
  const recorder = createDurableRecorder({ storage });
  try {
    seed(storage, "thread-1", "trace-1", "source-1");
    const accepted = recorder.acceptHandoff({
      sourceInvocationId: "source-1", sourceAgentId: "codex", targetAgentId: "grok",
      contentHash: "content-1",
    });
    const session = { id: "thread-1", title: "Handoff", projectDir: "C:/repo", messages: [] };
    recorder.startInvocation({
      session, invocationId: "target-1", threadId: "thread-1", traceId: "trace-1",
      handoffId: accepted.record.handoffId, agentId: "grok", providerKey: "grok:model",
      workspaceKey: "base:C:/repo", capacityTokens: 1000, parentInvocationId: "source-1",
    });
    assert.equal(storage.handoffs.get(accepted.record.handoffId).receiveStatus, "started");
    recorder.completeInvocation({
      invocationId: "target-1", code: 1, reason: "provider-failed",
      endPayload: { terminalState: "failed" },
    });
    const finished = storage.handoffs.get(accepted.record.handoffId);
    assert.equal(finished.completeStatus, "failed");
    assert.equal(finished.targetInvocationId, "target-1");
    assert.equal(storage.invocations.get("target-1").traceId, "trace-1");
  } finally {
    recorder.close();
    storage.close();
  }
});

test("restart reconcile closes pending handoffs without inventing success", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    seed(storage, "thread-1", "trace-1", "source-1");
    const accepted = storage.handoffs.accept({
      sourceInvocationId: "source-1", targetAgentId: "grok", contentHash: "content-1",
    });
    assert.equal(storage.handoffs.reconcilePending("2026-08-12T00:00:00.000Z"), 1);
    const recovered = storage.handoffs.get(accepted.record.handoffId);
    assert.equal(recovered.receiveStatus, "not_started");
    assert.equal(recovered.completeStatus, "failed");
    assert.equal(recovered.failureStage, "reconcile");
  } finally {
    storage.close();
  }
});

const assert = require("node:assert/strict");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const { createDurableRecorder } = require("../../src/storage/durable-recorder");

test("execution read model restores failure and handoff causality from SQLite", () => {
  const storage = createStorage({ file: ":memory:" });
  const recorder = createDurableRecorder({ storage });
  try {
    storage.threads.upsert({ id: "thread-1", title: "Trace", projectDir: "C:/repo" });
    const window = storage.windows.create({
      id: "window-1",
      threadId: "thread-1",
      agentId: "codex",
      providerKey: "codex:gpt",
      workspaceKey: "base:C:/repo",
      generation: 1,
      capacityTokens: 1000,
    });
    storage.traces.start({ id: "trace-1", threadId: "thread-1" });
    storage.invocations.start({
      id: "source-1",
      threadId: "thread-1",
      traceId: "trace-1",
      windowId: window.id,
      agentId: "codex",
    });
    const accepted = storage.handoffs.accept({
      sourceInvocationId: "source-1",
      targetAgentId: "grok",
      contentHash: "handoff",
    });
    storage.handoffs.markEnqueued(accepted.record.handoffId);
    recorder.startInvocation({
      session: { id: "thread-1", title: "Trace", projectDir: "C:/repo", messages: [] },
      invocationId: "target-1",
      threadId: "thread-1",
      traceId: "trace-1",
      handoffId: accepted.record.handoffId,
      agentId: "grok",
      providerKey: "grok:model",
      workspaceKey: "base:C:/repo",
      capacityTokens: 1000,
      parentInvocationId: "source-1",
      triggerType: "a2a-handoff",
    });
    recorder.completeInvocation({ invocationId: "target-1", code: 7, reason: "provider-failed" });

    const traces = storage.executions.listForThread("thread-1");
    assert.equal(traces[0].invocations.at(-1).outcome.errorCode, "provider_exit_7");
    assert.equal(traces[0].handoffs[0].completeStatus, "failed");
    const detail = storage.executions.inspect("thread-1", "trace-1");
    assert.ok(detail.invocations.at(-1).events.some((event) => event.kind === "invocation-end"));
    assert.equal(storage.executions.inspect("other-thread", "trace-1"), null);
    const failed = storage.executions.searchForThread("thread-1", {
      agentId: "grok",
      failuresOnly: true,
      query: "provider_exit_7",
    });
    assert.equal(failed.page.total, 1);
    assert.equal(failed.traces[0].traceId, "trace-1");
    assert.equal(storage.executions.searchForThread("other-thread").page.total, 0);
    const exported = storage.executions.export("thread-1", "trace-1");
    assert.equal(exported.capturePolicy, "structural-metadata-v1");
    assert.equal(exported.trace.invocations.at(-1).events.at(-1).payload.code, 7);
    assert.equal(exported.trace.invocations.at(-1).events.at(-1).payload.text, undefined);
    assert.equal(storage.executions.export("other-thread", "trace-1"), null);
  } finally {
    recorder.close();
    storage.close();
  }
});

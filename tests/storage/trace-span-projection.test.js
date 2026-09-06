const assert = require("node:assert/strict");
const test = require("node:test");
const { createStorage } = require("../../src/storage");
const { projectTraceSpans } = require("../../src/storage/trace-span-projection");

function fixture() {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.upsert({ id: "thread-1", projectDir: "C:/repo" });
  const window = storage.windows.create({
    id: "window-1",
    threadId: "thread-1",
    agentId: "codex",
    providerKey: "codex:gpt",
    workspaceKey: "base:C:/repo",
    generation: 2,
    capacityTokens: 1000,
  });
  storage.traces.start({ id: "trace-1", threadId: "thread-1" });
  storage.invocations.start({
    id: "inv-1",
    threadId: "thread-1",
    traceId: "trace-1",
    windowId: window.id,
    agentId: "codex",
    startedAt: "2026-08-13T00:00:00.000Z",
  });
  return storage;
}

test("span projection derives generation tool recall and links without span writes", () => {
  const storage = fixture();
  try {
    storage.invocations.appendEvent({
      invocationId: "inv-1",
      kind: "tool.started",
      createdAt: "2026-08-13T00:00:01.000Z",
      payload: { toolId: "tool-1", toolName: "read_file" },
    });
    storage.invocations.appendEvent({
      invocationId: "inv-1",
      kind: "tool.finished",
      createdAt: "2026-08-13T00:00:02.000Z",
      payload: { toolId: "tool-1", toolName: "read_file", status: "ok", text: "secret" },
    });
    storage.memoryEvents.record({
      eventType: "memory_injected",
      threadId: "thread-1",
      invocationId: "inv-1",
      agentId: "codex",
      operationKey: "inject:inv-1:bootstrap",
      payloadVersion: 1,
      payload: { delivered: 2, selected: 2, availability: { state: "available" } },
      createdAt: "2026-08-13T00:00:03.000Z",
    });
    storage.invocations.appendEvent({
      invocationId: "inv-1",
      kind: "invocation-end",
      payload: { code: 0 },
      createdAt: "2026-08-13T00:00:04.000Z",
    });
    storage.invocations.finish("inv-1", {
      state: "completed",
      endedAt: "2026-08-13T00:00:04.000Z",
    });
    const projection = projectTraceSpans(storage.db, "trace-1");
    assert.equal(projection.complete, true);
    assert.deepEqual(
      projection.spans.map((span) => span.kind),
      ["generation", "tool", "recall"]
    );
    assert.equal(projection.spans[0].attributes.generation, 2);
    assert.equal(projection.spans[1].attributes.text, undefined);
    assert.equal(projection.spans[2].attributes.query, undefined);
    assert.equal(projection.spans[2].attributes.delivered, 2);
    assert.equal(projection.spans[2].attributes.source, null);
    assert.equal(
      storage.db.prepare("SELECT name FROM sqlite_master WHERE name = 'trace_spans'").get(),
      undefined
    );
  } finally {
    storage.close();
  }
});

test("span projection and health expose unfinished tool spans", () => {
  const storage = fixture();
  try {
    storage.invocations.appendEvent({
      invocationId: "inv-1",
      kind: "tool.started",
      payload: { toolId: "open", toolName: "shell" },
    });
    const projection = projectTraceSpans(storage.db, "trace-1");
    assert.equal(projection.spans.find((span) => span.kind === "tool").complete, false);
    assert.equal(storage.observability.health().checks.span_missing_end, 0);

    storage.invocations.finish("inv-1", {
      state: "failed",
      terminalReason: "provider-failed",
    });
    storage.traces.finish("trace-1", {
      state: "failed",
      terminalReason: "request-error",
    });

    const health = storage.observability.health();
    assert.equal(health.checks.span_missing_end, 1);
    assert.ok(health.alerts.some((alert) => alert.code === "span_missing_end"));
  } finally {
    storage.close();
  }
});

test("span projection preserves failed tools and treats orphan finishes as incomplete", () => {
  const storage = fixture();
  try {
    storage.invocations.appendEvent({
      invocationId: "inv-1",
      kind: "tool.started",
      createdAt: "2026-08-13T00:00:01.000Z",
      payload: { toolId: "failed-tool", toolName: "shell" },
    });
    storage.invocations.appendEvent({
      invocationId: "inv-1",
      kind: "tool.finished",
      createdAt: "2026-08-13T00:00:02.000Z",
      payload: { toolId: "failed-tool", toolName: "shell", status: "failed" },
    });
    storage.invocations.appendEvent({
      invocationId: "inv-1",
      kind: "tool.finished",
      createdAt: "2026-08-13T00:00:03.000Z",
      payload: { toolId: "orphan-tool", toolName: "write", status: "ok" },
    });

    const tools = projectTraceSpans(storage.db, "trace-1").spans.filter(
      (span) => span.kind === "tool"
    );
    assert.deepEqual(
      tools.map((span) => ({
        id: span.attributes.toolId,
        state: span.state,
        complete: span.complete,
        startedAt: span.startedAt,
        orphanFinish: span.attributes.orphanFinish,
      })),
      [
        {
          id: "failed-tool",
          state: "failed",
          complete: true,
          startedAt: "2026-08-13T00:00:01.000Z",
          orphanFinish: false,
        },
        {
          id: "orphan-tool",
          state: "orphaned",
          complete: false,
          startedAt: null,
          orphanFinish: true,
        },
      ]
    );
  } finally {
    storage.close();
  }
});

test("span projection exposes inject source and write outcomes", () => {
  const storage = fixture();
  try {
    storage.memoryEvents.record({
      eventType: "memory_injected",
      threadId: "thread-1",
      invocationId: "inv-1",
      agentId: "codex",
      operationKey: "inject:inv-1:a2a",
      payloadVersion: 1,
      payload: {
        source: "a2a",
        delivered: 2,
        selected: 3,
        droppedIds: ["memory-drop"],
        availability: { state: "available" },
      },
      createdAt: "2026-08-13T00:00:03.000Z",
    });
    storage.memoryEvents.record({
      eventType: "memory_searched",
      threadId: "thread-1",
      invocationId: "inv-1",
      agentId: "codex",
      operationKey: "recall:inv-1:search",
      payloadVersion: 1,
      payload: {
        memoryHits: 1,
        totalHits: 4,
        memoryIds: ["memory-1"],
        requestedLayers: ["memory"],
      },
      createdAt: "2026-08-13T00:00:04.000Z",
    });
    storage.memoryEvents.record({
      eventType: "memory_write_completed",
      threadId: "thread-1",
      invocationId: "inv-1",
      agentId: "codex",
      operationKey: "memory-write:inv-1:op-1",
      payloadVersion: 1,
      payload: { outcome: "created", kind: "decision", topic: "storage.authoritative" },
      createdAt: "2026-08-13T00:00:05.000Z",
    });
    const recalls = projectTraceSpans(storage.db, "trace-1").spans.filter(
      (span) => span.kind === "recall"
    );
    assert.deepEqual(
      recalls.map((span) => ({
        name: span.name,
        source: span.attributes.source,
        delivered: span.attributes.delivered,
        dropped: span.attributes.dropped,
        memoryHits: span.attributes.memoryHits,
        outcome: span.attributes.outcome,
        topic: span.attributes.topic,
      })),
      [
        {
          name: "memory_injected",
          source: "a2a",
          delivered: 2,
          dropped: 1,
          memoryHits: 0,
          outcome: null,
          topic: null,
        },
        {
          name: "memory_searched",
          source: null,
          delivered: 1,
          dropped: 0,
          memoryHits: 1,
          outcome: null,
          topic: null,
        },
        {
          name: "memory_write_completed",
          source: null,
          delivered: 0,
          dropped: 0,
          memoryHits: 0,
          outcome: "created",
          topic: "storage.authoritative",
        },
      ]
    );
  } finally {
    storage.close();
  }
});

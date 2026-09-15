const assert = require("node:assert/strict");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const { createDurableRecorder } = require("../../src/storage/durable-recorder");
const { countIncompleteTraceSpans } = require("../../src/storage/trace-span-projection");
const {
  listDanglingToolSpans,
  repairDanglingToolSpans,
} = require("../../src/storage/offline/dangling-tool-span-repair");

const AGENT = "codex";
const PROVIDER_KEY = "codex:gpt-5.6-sol";
const WORKSPACE_KEY = "base:C:/repo";

function fixture() {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.upsert({ id: "thread-1", projectDir: "C:/repo" });
  const window = storage.windows.create({
    id: "window-1",
    threadId: "thread-1",
    agentId: AGENT,
    providerKey: PROVIDER_KEY,
    workspaceKey: WORKSPACE_KEY,
    generation: 2,
    capacityTokens: 1000,
  });
  storage.traces.start({ id: "trace-1", threadId: "thread-1" });
  storage.invocations.start({
    id: "inv-1",
    threadId: "thread-1",
    traceId: "trace-1",
    windowId: window.id,
    agentId: AGENT,
    startedAt: "2026-08-13T00:00:00.000Z",
  });
  return storage;
}

function startTool(storage, { toolId = "tool-1", createdAt = "2026-08-13T00:00:01.000Z" } = {}) {
  storage.invocations.appendEvent({
    invocationId: "inv-1",
    kind: "tool.started",
    createdAt,
    payload: {
      agent: AGENT,
      invocationId: "inv-1",
      toolName: "shell",
      toolId,
      args: { command: "build" },
      title: "build",
      toolKind: "shell",
      ts: createdAt,
    },
  });
}

function finishTrace(storage) {
  storage.traces.finish("trace-1", { state: "failed", terminalReason: "provider-failed" });
}

/**
 * The guard the health alert exists to enforce: once an invocation is terminal,
 * every tool.started it emitted must have a paired tool.finished.
 */
function unpairedToolStarts(storage) {
  return countIncompleteTraceSpans(storage.db, "2000-01-01");
}

test("forceTerminalInvocation closes in-flight tools in the same transaction", () => {
  const storage = fixture();
  const warnings = [];
  const recorder = createDurableRecorder({
    storage,
    logger: { ...console, warn: (message) => warnings.push(message) },
  });
  try {
    startTool(storage);
    // The crash path: no tool.finished was ever written, and the process died.
    const record = recorder.forceTerminalInvocation("inv-1", {
      state: "failed",
      reason: "provider-failed",
      failureStage: "provider_run",
    });
    assert.ok(record, "force-terminal should return the finished row");
    finishTrace(storage);

    const events = storage.invocations.listEvents("inv-1");
    const started = events.find((event) => event.kind === "tool.started");
    const finished = events.find((event) => event.kind === "tool.finished");
    assert.ok(finished, "a synthetic tool.finished was appended");
    assert.equal(finished.payload.toolId, "tool-1");
    assert.equal(finished.payload.status, "interrupted");
    assert.equal(finished.payload.state, "interrupted");
    assert.equal(finished.payload.syntheticTerminal, true);
    assert.equal(finished.payload.failureSource, "lifecycle-terminal");
    assert.equal(finished.payload.error, "Provider run ended before the tool reported completion.");
    assert.equal(finished.payload.result.error, finished.payload.error);
    // The synthetic finish must not precede its own start.
    assert.ok(Date.parse(finished.createdAt) >= Date.parse(started.createdAt));
    assert.ok(warnings.some((message) => message.includes("closed 1 dangling tool span")));
    assert.equal(unpairedToolStarts(storage), 0);
  } finally {
    recorder.close();
    storage.close();
  }
});

test("forceTerminalInvocation marks aborted invocations as cancelled", () => {
  const storage = fixture();
  const recorder = createDurableRecorder({ storage });
  try {
    startTool(storage);
    recorder.forceTerminalInvocation("inv-1", { state: "aborted", reason: "user-stop" });
    finishTrace(storage);

    const finished = storage.invocations
      .listEvents("inv-1")
      .find((event) => event.kind === "tool.finished");
    assert.ok(finished);
    assert.equal(finished.payload.status, "cancelled");
    assert.equal(finished.payload.state, "cancelled");
    assert.equal(finished.payload.error, "Tool execution cancelled by invocation stop.");
    assert.equal(unpairedToolStarts(storage), 0);
  } finally {
    recorder.close();
    storage.close();
  }
});

test("forceTerminalInvocation leaves paired tool spans untouched", () => {
  const storage = fixture();
  const recorder = createDurableRecorder({ storage });
  try {
    startTool(storage);
    storage.invocations.appendEvent({
      invocationId: "inv-1",
      kind: "tool.finished",
      createdAt: "2026-08-13T00:00:02.000Z",
      payload: {
        agent: AGENT,
        invocationId: "inv-1",
        toolName: "shell",
        toolId: "tool-1",
        status: "ok",
      },
    });
    recorder.forceTerminalInvocation("inv-1", { state: "failed", reason: "provider-failed" });
    finishTrace(storage);

    const finishes = storage.invocations
      .listEvents("inv-1")
      .filter((event) => event.kind === "tool.finished");
    assert.equal(
      finishes.length,
      1,
      "no synthetic finish is appended when the span already closed"
    );
    assert.equal(finishes[0].payload.syntheticTerminal, undefined);
    assert.equal(unpairedToolStarts(storage), 0);
  } finally {
    recorder.close();
    storage.close();
  }
});

test("forceTerminalInvocation closes every concurrently open tool", () => {
  const storage = fixture();
  const recorder = createDurableRecorder({ storage });
  try {
    startTool(storage, { toolId: "tool-early", createdAt: "2026-08-13T00:00:01.000Z" });
    startTool(storage, { toolId: "tool-late", createdAt: "2026-08-13T23:00:00.000Z" });
    recorder.forceTerminalInvocation("inv-1", { state: "failed", reason: "provider-failed" });
    finishTrace(storage);

    const finishes = storage.invocations
      .listEvents("inv-1")
      .filter((event) => event.kind === "tool.finished");
    assert.equal(finishes.length, 2);
    assert.deepEqual(finishes.map((event) => event.payload.toolId).sort(), [
      "tool-early",
      "tool-late",
    ]);
    assert.equal(unpairedToolStarts(storage), 0);
  } finally {
    recorder.close();
    storage.close();
  }
});

test("a synthetic finish never precedes its own tool.started", () => {
  const storage = fixture();
  const recorder = createDurableRecorder({ storage });
  try {
    startTool(storage, { toolId: "late-tool", createdAt: "2026-08-13T23:00:00.000Z" });
    // A terminal timestamp older than the tool start (clock skew, backdated
    // reconcile) must not produce a negative-duration span.
    const closed = recorder.closeDanglingToolSpans(
      "inv-1",
      { threadId: "thread-1", agentId: AGENT, endedAt: "2026-08-13T10:00:00.000Z" },
      { endedAt: "2026-08-13T10:00:00.000Z" }
    );
    assert.equal(closed, 1);
    const finished = storage.invocations
      .listEvents("inv-1")
      .find((event) => event.kind === "tool.finished");
    assert.ok(finished);
    assert.equal(finished.createdAt, "2026-08-13T23:00:00.000Z");
  } finally {
    recorder.close();
    storage.close();
  }
});

test("reconcileStartup closes tools left open by a crashed SHIFT process", () => {
  const storage = fixture();
  const recorder = createDurableRecorder({ storage });
  try {
    startTool(storage, { createdAt: "2026-08-13T00:00:01.000Z" });
    const report = recorder.reconcileStartup("2026-08-14T00:00:00.000Z");
    assert.equal(report.invocations, 1);
    finishTrace(storage);

    const finished = storage.invocations
      .listEvents("inv-1")
      .find((event) => event.kind === "tool.finished");
    assert.ok(finished, "startup reconcile closed the dangling span");
    assert.equal(finished.payload.status, "interrupted");
    assert.equal(finished.payload.error, "SHIFT restarted while the tool was still running.");
    assert.equal(finished.payload.syntheticTerminal, true);
    assert.equal(unpairedToolStarts(storage), 0);
  } finally {
    recorder.close();
    storage.close();
  }
});

test("listDanglingToolSpans finds terminal invocations with unpaired tool.started", () => {
  const storage = fixture();
  try {
    startTool(storage, { toolId: "dangling" });
    // Emulate a database written by an older build: terminal invocation, no tool.finished.
    storage.invocations.finish("inv-1", { state: "aborted", endedAt: "2026-08-14T00:00:00.000Z" });

    const candidates = listDanglingToolSpans(storage);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].invocationId, "inv-1");
    assert.equal(candidates[0].agentId, AGENT);
    assert.equal(candidates[0].state, "aborted");
    assert.equal(candidates[0].tools.length, 1);
    assert.equal(candidates[0].tools[0].toolId, "dangling");
    assert.equal(candidates[0].tools[0].toolName, "shell");
  } finally {
    storage.close();
  }
});

test("listDanglingToolSpans ignores active invocations and fully paired spans", () => {
  const storage = fixture();
  try {
    startTool(storage, { toolId: "paired" });
    storage.invocations.appendEvent({
      invocationId: "inv-1",
      kind: "tool.finished",
      createdAt: "2026-08-13T00:00:02.000Z",
      payload: {
        agent: AGENT,
        invocationId: "inv-1",
        toolName: "shell",
        toolId: "paired",
        status: "ok",
      },
    });
    storage.invocations.finish("inv-1", { state: "completed" });
    assert.deepEqual(listDanglingToolSpans(storage), []);
  } finally {
    storage.close();
  }
});

test("repairDanglingToolSpans dry-run reports without writing", () => {
  const storage = fixture();
  try {
    startTool(storage, { toolId: "dangling" });
    storage.invocations.finish("inv-1", { state: "failed", endedAt: "2026-08-14T00:00:00.000Z" });

    const report = repairDanglingToolSpans({ storage, dryRun: true });
    assert.equal(report.ok, true);
    assert.equal(report.dryRun, true);
    assert.equal(report.candidateCount, 1);
    assert.equal(report.repaired.length, 0);
    assert.equal(listDanglingToolSpans(storage).length, 1, "dry-run changed nothing");
  } finally {
    storage.close();
  }
});

test("repairDanglingToolSpans closes historical spans and leaves none behind", () => {
  const storage = fixture();
  try {
    startTool(storage, { toolId: "dangling", createdAt: "2026-08-13T00:00:01.000Z" });
    storage.invocations.finish("inv-1", { state: "aborted", endedAt: "2026-08-14T00:00:00.000Z" });

    const report = repairDanglingToolSpans({ storage, dryRun: false });
    assert.equal(report.ok, true);
    assert.equal(report.dryRun, false);
    assert.equal(report.candidateCount, 1);
    assert.equal(report.repaired.length, 1);
    assert.equal(report.repaired[0].invocationId, "inv-1");
    assert.equal(report.repaired[0].closed, 1);
    assert.equal(report.remaining, 0);
    assert.equal(listDanglingToolSpans(storage).length, 0);

    const finished = storage.invocations
      .listEvents("inv-1")
      .find((event) => event.kind === "tool.finished");
    assert.ok(finished);
    assert.equal(finished.payload.status, "cancelled");
    assert.equal(finished.payload.error, "SHIFT process ended while the tool was still running.");
    assert.equal(finished.payload.syntheticTerminal, true);
    finishTrace(storage);
    assert.equal(unpairedToolStarts(storage), 0);
  } finally {
    storage.close();
  }
});

test("repairDanglingToolSpans is a no-op on a current database", () => {
  const storage = fixture();
  const recorder = createDurableRecorder({ storage });
  try {
    startTool(storage);
    recorder.forceTerminalInvocation("inv-1", { state: "failed", reason: "provider-failed" });

    const report = repairDanglingToolSpans({ storage, dryRun: false });
    assert.equal(report.candidateCount, 0);
    assert.equal(report.repaired.length, 0);
    assert.equal(report.ok, true);
  } finally {
    recorder.close();
    storage.close();
  }
});

test("listDanglingToolSpans degrades safely without storage", () => {
  assert.deepEqual(listDanglingToolSpans(null), []);
  assert.deepEqual(listDanglingToolSpans({}), []);
  assert.throws(() => repairDanglingToolSpans({}), /SQLite storage is required/);
});

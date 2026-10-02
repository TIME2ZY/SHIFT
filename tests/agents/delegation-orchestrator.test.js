"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createStorage } = require("../../src/storage");
const { createDelegationOrchestrator } = require("../../src/agents/delegation-orchestrator");
const { delegationProgress } = require("../../src/agents/delegation-progress");
const contract = {
  workflowId: "software_delivery",
  goal: "Add export",
  deliverables: ["export"],
  acceptanceCriteria: ["valid data"],
  subtasks: [{ id: "export", title: "Export", description: "Export data" }],
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(t, start) {
  const storage = createStorage({ file: ":memory:" });
  const repository = storage.collaborationTasks;
  const traces = new Map();
  const runs = new Map();
  const calls = [];
  let orchestrator;
  const runtime = {
    runs,
    stopRun(id) {
      runs.get(id)?.done.resolve();
    },
  };
  orchestrator = createDelegationOrchestrator({
    repository,
    seats: {
      listEnabledForThread: () => [{ seatId: "codex-seat", providerId: "codex", enabled: true }],
    },
    agents: { codex: {} },
    runtime,
    getSession: (id) => storage.threads.get(id),
    traces: {
      get: (id) => traces.get(id),
      findByClientTurnId: (id, turn) =>
        [...traces.values()].find((row) => row.threadId === id && row.clientTurnId === turn),
    },
    registry: { acceptanceReadiness: () => ({ ok: false }) },
    logger: { error() {} },
    startRun: async ({ body }) => {
      const id = "trace-" + calls.length;
      const done = deferred();
      const trace = {
        id,
        threadId: body.sessionId,
        clientTurnId: body.clientTurnId,
        metadata: { purpose: body.internalPurpose },
        state: "active",
      };
      traces.set(id, trace);
      calls.push(body);
      runs.set(body.sessionId, { traceId: id, done });
      await start?.(body, done, storage);
      return {
        ok: true,
        json: { traceId: id },
        promise: done.promise.then(() => {
          trace.state = "completed";
          runs.delete(body.sessionId);
        }),
      };
    },
  });
  function draft(id) {
    storage.threads.create({ id });
    const initial = orchestrator.initialize(id);
    return orchestrator.saveDraft(id, contract, initial.version);
  }
  t.after(async () => {
    await orchestrator.close();
    storage.close();
  });
  return { orchestrator, repository, calls, runs, draft };
}
test("published FIFO waits for recovery and cancellation cleanup before next start", async (t) => {
  const f = fixture(t);
  for (const id of ["one", "two"]) f.orchestrator.submit(id, f.draft(id).version);
  assert.equal(f.calls.length, 0);
  f.orchestrator.allowRecoveredQueue();
  await tick();
  assert.equal(f.calls[0].sessionId, "one");
  f.orchestrator.cancel("one");
  assert.equal(f.repository.get("one").delegationState, "cancelling");
  await tick();
  assert.equal(f.repository.get("one").delegationState, "cancelled");
  assert.equal(f.calls[1].sessionId, "two");
  f.orchestrator.cancel("two");
  await tick();
});
test("plain successful text never completes delegation; missing evidence repairs are bounded", async (t) => {
  const f = fixture(t, (body, done) => done.resolve());
  f.orchestrator.allowRecoveredQueue();
  f.orchestrator.submit("one", f.draft("one").version);
  await tick();
  const result = f.repository.get("one");
  assert.equal(result.delegationState, "failed");
  assert.equal(result.delegationReason, "acceptance_incomplete");
  assert.equal(result.repairCount, 2);
  assert.deepEqual(
    f.calls.map((body) => body.duty),
    ["discuss", "accept", "accept"]
  );
  assert.equal(f.orchestrator.submit("one", 0).queueSeq, result.queueSeq);
  assert.equal(f.calls.length, 3);
});
test("cancel during delayed preparation startup stops the owned run and prevents draft overwrite", async (t) => {
  const starting = deferred();
  const f = fixture(t, () => starting.promise);
  f.orchestrator.allowRecoveredQueue();
  f.draft("one");
  await f.orchestrator.prepare("one", { prompt: "export", clientTurnId: "turn-1" });
  const repeated = await f.orchestrator.prepare("one", {
    prompt: "different",
    clientTurnId: "turn-1",
  });
  assert.equal(repeated.traceId, "trace-0");
  assert.equal(f.calls.length, 1);
  assert.throws(() => f.orchestrator.submit("one", f.repository.get("one").version), {
    code: "TASK_PREPARING",
  });
  f.orchestrator.cancel("one");
  starting.resolve();
  await tick();
  assert.equal(f.repository.get("one").delegationState, "cancelled");
  assert.deepEqual(f.repository.get("one").contract, contract);
});
test("subtask progress only uses matching goal and plan evidence", () => {
  const task = {
    contract,
    goalHash: "goal",
    delegationState: "running",
    artifacts: {
      progress: {
        goal_hash: "stale",
        plan_hash: null,
        current: "export",
        completed: [{ item: "export", evidence: ["test"] }],
        blockers: [],
      },
    },
  };
  assert.equal(delegationProgress(task).items[0].state, "pending");
  task.artifacts.progress.goal_hash = "goal";
  assert.equal(delegationProgress(task).items[0].state, "reported_complete");
  task.delegationState = "completed";
  assert.equal(delegationProgress(task).items[0].state, "accepted");
});

"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { createStorage } = require("../../src/storage");
const { createTaskScheduler } = require("../../src/tasks/scheduler");
const { createTeamCatalog } = require("../../src/teams/catalog");
const { createAgentCatalog } = require("../../src/agents/agent-catalog");
const { contract, team, receipt } = require("../helpers/task-plan");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function publish(repo, spec = contract) {
  const task = repo.create(),
    saved = repo.saveDraft(task.id, spec, task.revision);
  return repo.submit(
    task.id,
    saved.revision,
    Object.fromEntries(
      spec.subtasks.map((node) => [node.id, { ...team, workflowId: node.workflowId }])
    )
  );
}
test("generic scheduler dispatches different Team definitions and dependency receipts without Git semantics", async (t) => {
  const s = createStorage({ file: ":memory:" }),
    seen = [];
  const definitions = ["sample", "summarize"].map((id) => ({
    id,
    capabilities: ["analysis"],
    roles: [{ id: "produce" }],
    execute: async (claim) => {
      seen.push({ workflow: claim.node.workflowId, inputs: claim.inputs });
      return receipt;
    },
  }));
  const catalog = createTeamCatalog({
    definitions,
    agents: {
      candidates: () => [{ id: "agent", label: "Agent", availabilityStatus: "available" }],
    },
  });
  const spec = {
    ...contract,
    subtasks: [
      contract.subtasks[0],
      { ...contract.subtasks[0], id: "second", dependsOn: ["first"], workflowId: "summarize" },
    ],
  };
  const task = publish(s.tasks, spec),
    scheduler = createTaskScheduler({ repository: s.tasks, teams: catalog });
  t.after(async () => {
    await scheduler.close();
    s.close();
  });
  scheduler.allowRecoveredQueue();
  await tick();
  await tick();
  assert.equal(s.tasks.get(task.id).state, "completed");
  assert.deepEqual(
    seen.map((v) => v.workflow),
    ["sample", "summarize"]
  );
  assert.equal(seen[1].inputs[0].nodeId, "first");
});
test("global preparation shares the serial slot and cancellation waits for Team cleanup", async (t) => {
  const s = createStorage({ file: ":memory:" });
  let release,
    entered = false;
  const scheduler = createTaskScheduler({
    repository: s.tasks,
    teams: {
      execute: async (_claim, { signal }) => {
        entered = true;
        await new Promise((resolve) => {
          release = resolve;
          signal.addEventListener("abort", () => {});
        });
        return receipt;
      },
    },
  });
  t.after(async () => {
    release?.();
    await scheduler.close();
    s.close();
  });
  const task = publish(s.tasks);
  scheduler.allowRecoveredQueue();
  await tick();
  assert.equal(entered, true);
  await assert.rejects(
    scheduler.prepare("draft", async () => {}),
    { code: "PLATFORM_BUSY" }
  );
  scheduler.cancel(task.id);
  assert.equal(s.tasks.get(task.id).state, "cancelling");
  release();
  await tick();
  assert.equal(s.tasks.get(task.id).state, "cancelled");
});
test("unresolved process ownership prevents any next claim", async (t) => {
  const s = createStorage({ file: ":memory:" }),
    task = publish(s.tasks);
  const scheduler = createTaskScheduler({
    repository: s.tasks,
    teams: {
      execute: () => {
        throw new Error("must not start");
      },
    },
    canDispatch: () => false,
    logger: { error() {} },
  });
  t.after(async () => {
    await scheduler.close();
    s.close();
  });
  scheduler.allowRecoveredQueue();
  await tick();
  assert.equal(scheduler.status().recoveryBlocked, true);
  assert.equal(s.tasks.get(task.id).state, "queued");
});
test("catalog selects capabilities and keeps reviewer and acceptance independent from producer", () => {
  const agents = createAgentCatalog({
    agents: { codex: {}, claude: {} },
    availability: { get: () => ({ status: "available" }), isRoutable: () => true },
  });
  const teams = createTeamCatalog({
    agents,
    definitions: [
      {
        id: "software_delivery",
        capabilities: ["software"],
        roles: [
          { id: "produce" },
          { id: "review", independent: true },
          { id: "accept", independent: true },
        ],
      },
    ],
  });
  const selected = teams.select({ workflowId: "software_delivery", capabilities: ["software"] });
  assert.notEqual(selected.bindings.produce.providerId, selected.bindings.review.providerId);
  assert.equal(selected.bindings.review.providerId, selected.bindings.accept.providerId);
  assert.throws(() => teams.select({ workflowId: "unknown", capabilities: ["software"] }), {
    code: "UNSUPPORTED_WORKFLOW",
  });
  assert.throws(() => agents.candidates(["unsupported"]), { code: "NO_CAPABLE_AGENT" });
});

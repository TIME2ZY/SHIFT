"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStorage } = require("../../src/storage");
const { selectDelegationTeam } = require("../../src/agents/delegation-team");

const contract = {
  workflowId: "software_delivery",
  goal: "Add export",
  deliverables: ["Export implementation"],
  acceptanceCriteria: ["Exports valid data"],
  subtasks: [{ id: "export", title: "Implement export", description: "Add the requested export" }],
};
const team = selectDelegationTeam({
  seats: [{ seatId: "seat", providerId: "codex", enabled: true }],
  agents: { codex: {} },
});
function draft(storage, id) {
  storage.threads.create({ id });
  const queue = storage.collaborationTasks.delegations;
  const initial = queue.initialize(id);
  return queue.saveDraft(id, contract, initial.version);
}
test("submission freezes contract and rejects stale or changed goal writes", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    const queue = storage.collaborationTasks.delegations;
    const prepared = draft(storage, "one");
    assert.throws(() => queue.saveDraft("one", contract, prepared.version - 1), {
      code: "TASK_REVISION_CONFLICT",
    });
    const published = queue.submit("one", prepared.version, team);
    assert.equal(published.delegationState, "queued");
    assert.equal(published.contractHash.length, 64);
    assert.throws(() => queue.saveDraft("one", contract, published.version), {
      code: "TASK_FROZEN",
    });
    assert.throws(
      () => storage.collaborationTasks.save({ ...published, goalNormalized: "Different scope" }),
      { code: "TASK_FROZEN" }
    );
    assert.equal(storage.collaborationTasks.get("one").goalNormalized, contract.goal);
    assert.equal(queue.submit("one", prepared.version, team).queueSeq, published.queueSeq);
    assert.equal(
      storage.collaborationTasks
        .get("one")
        .history.filter((event) => event.type === "delegation_submitted").length,
      1
    );
  } finally {
    storage.close();
  }
});
test("FIFO has one global slot and cancellation keeps slot until terminal cleanup", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    const queue = storage.collaborationTasks.delegations;
    for (const id of ["one", "two", "three"]) {
      const task = draft(storage, id);
      queue.submit(id, task.version, team);
    }
    assert.equal(queue.claimNext().threadId, "one");
    assert.equal(queue.claimNext(), null);
    assert.equal(queue.cancel("one").delegationState, "cancelling");
    assert.equal(queue.claimNext(), null);
    assert.equal(queue.finish("one", { state: "failed" }).delegationState, "cancelled");
    assert.equal(queue.cancel("two").delegationState, "cancelled");
    assert.equal(queue.claimNext().threadId, "three");
    assert.throws(() => queue.finish("three", { state: "completed" }), {
      code: "ACCEPTANCE_REQUIRED",
    });
    assert.equal(storage.collaborationTasks.get("three").delegationState, "running");
  } finally {
    storage.close();
  }
});
test("database reopen retains queue and interruption never synthesizes success", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shift-delegation-"));
  const file = path.join(dir, "shift.sqlite");
  let storage = createStorage({ file });
  try {
    for (const id of ["one", "two"]) {
      const task = draft(storage, id);
      storage.collaborationTasks.delegations.submit(id, task.version, team);
    }
    storage.collaborationTasks.delegations.claimNext();
    storage.close();
    storage = createStorage({ file });
    assert.equal(storage.collaborationTasks.delegations.reconcile(), 1);
    assert.equal(storage.collaborationTasks.get("one").delegationState, "failed");
    assert.equal(storage.collaborationTasks.get("one").delegationReason, "application_interrupted");
    assert.equal(storage.collaborationTasks.get("two").delegationState, "queued");
    assert.equal(storage.collaborationTasks.delegations.claimNext().threadId, "two");
  } finally {
    if (storage.db.open) storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

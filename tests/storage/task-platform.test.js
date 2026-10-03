"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { createStorage } = require("../../src/storage");
const { normalizeDelegationContract } = require("../../src/shared/delegation-contracts");
const { contract, team, receipt } = require("../helpers/task-plan");
function fixture(t) {
  const storage = createStorage({ file: ":memory:" });
  t.after(() => storage.close());
  return storage;
}
function publish(repo, spec = contract) {
  const task = repo.create();
  const saved = repo.saveDraft(task.id, spec, task.revision);
  return repo.submit(
    task.id,
    saved.revision,
    Object.fromEntries(spec.subtasks.map((node) => [node.id, team]))
  );
}
test("Task exists without Project or Thread, with one independent write authority", (t) => {
  const s = fixture(t),
    task = s.tasks.create();
  assert.equal(task.projectKey, null);
  assert.equal(task.preparationThreadId, null);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM threads").get().n, 0);
  assert.equal(s.collaborationTasks.delegations, undefined);
  assert.equal(
    s.db
      .prepare("PRAGMA table_info(collaboration_tasks)")
      .all()
      .some((c) => c.name === "delegation_state"),
    false
  );
});
test("draft CAS, plan freeze, publication replay and version conflicts", (t) => {
  const repo = fixture(t).tasks,
    task = repo.create(),
    saved = repo.saveDraft(task.id, contract, task.revision);
  assert.throws(() => repo.saveDraft(task.id, contract, task.revision), {
    code: "TASK_REVISION_CONFLICT",
  });
  const first = repo.submit(task.id, saved.revision, { first: team }),
    second = repo.submit(task.id, saved.revision, {});
  assert.equal(first.plan.id, second.plan.id);
  assert.equal(first.plan.hash, second.plan.hash);
  assert.equal(first.queueSeq, 1);
  assert.throws(() => repo.submit(task.id, 0, {}), { code: "TASK_REVISION_CONFLICT" });
  assert.throws(() => repo.saveDraft(task.id, contract, first.revision), { code: "TASK_FROZEN" });
  assert.equal(repo.create({ parentTaskId: task.id }).contract.goal, contract.goal);
});
test("plan rejects missing dependencies, cycles and unassigned global outcomes", () => {
  assert.throws(
    () =>
      normalizeDelegationContract({
        ...contract,
        subtasks: [{ ...contract.subtasks[0], dependsOn: ["missing"] }],
      }),
    /不存在/
  );
  assert.throws(
    () =>
      normalizeDelegationContract({
        ...contract,
        subtasks: [{ ...contract.subtasks[0], dependsOn: ["first"] }],
      }),
    /环/
  );
  assert.throws(
    () => normalizeDelegationContract({ ...contract, acceptanceCriteria: ["unassigned"] }),
    /必须分配/
  );
  assert.equal(
    normalizeDelegationContract({
      ...contract,
      subtasks: [{ ...contract.subtasks[0], workflowId: "another_team" }],
    }).subtasks[0].workflowId,
    "another_team"
  );
});
test("DAG nodes are actually claimed, downstream receives only versioned accepted predecessor output", (t) => {
  const repo = fixture(t).tasks;
  const spec = {
    ...contract,
    subtasks: [
      { ...contract.subtasks[0], id: "second", dependsOn: ["first"] },
      contract.subtasks[0],
    ],
  };
  const task = publish(repo, spec),
    run = repo.claimNext();
  assert.equal(run.node.id, "first");
  assert.equal(repo.claimNext(), null);
  assert.throws(
    () =>
      repo.finishRun(run.id, {
        ...receipt,
        acceptance: {
          ...receipt.acceptance,
          assessedBy: { providerId: "outsider", roleId: "produce" },
        },
      }),
    { code: "ACCEPTANCE_REQUIRED" }
  );
  assert.throws(
    () =>
      repo.finishRun(run.id, { ...receipt, acceptance: { ...receipt.acceptance, evidence: {} } }),
    { code: "ACCEPTANCE_REQUIRED" }
  );
  assert.throws(() => repo.finishRun(run.id, { state: "completed" }), {
    code: "ACCEPTANCE_REQUIRED",
  });
  assert.throws(
    () =>
      repo.finishRun(run.id, {
        ...receipt,
        artifacts: [{ kind: "file", locator: "x", summary: "x" }],
      }),
    { code: "ARTIFACT_VERSION_REQUIRED" }
  );
  assert.equal(repo.finishRun(run.id, receipt).state, "running");
  assert.equal(
    repo.finishRun(run.id, {
      acceptance: receipt.acceptance,
      artifacts: receipt.artifacts,
      state: "completed",
    }).state,
    "running"
  );
  assert.throws(() => repo.finishRun(run.id, { state: "failed" }), {
    code: "RUN_RECEIPT_CONFLICT",
  });
  const next = repo.claimNext();
  assert.equal(next.node.id, "second");
  assert.equal(next.attempt, 1);
  assert.notEqual(next.id, run.id);
  assert.equal(next.inputs[0].artifacts[0].contentHash, "a".repeat(64));
  assert.equal(next.inputs[0].acceptance.verdict, "accepted");
  const done = repo.finishRun(next.id, receipt);
  assert.equal(done.id, task.id);
  assert.equal(done.state, "completed");
  assert.equal(done.acceptances.length, 2);
});
test("bounded attempts preserve failed results and never feed them into dependencies", (t) => {
  const repo = fixture(t).tasks,
    task = publish(repo);
  for (let n = 1; n <= 3; n++) {
    const run = repo.claimNext();
    assert.equal(run.attempt, n);
    repo.finishRun(run.id, {
      state: "failed",
      reason: "missing_evidence",
      retryable: true,
      artifacts: [{ kind: "workspace", locator: "dir", summary: "partial" }],
    });
  }
  const done = repo.get(task.id);
  assert.equal(done.state, "failed");
  assert.equal(done.runs.length, 3);
  assert.equal(done.artifacts.length, 3);
  assert.equal(done.acceptances.length, 0);
});
test("unknown side effects prevent replay even when a Team asks to retry", (t) => {
  const repo = fixture(t).tasks,
    task = publish(repo);
  repo.finishRun(repo.claimNext().id, {
    state: "failed",
    reason: "external_result_unknown",
    retryable: true,
    unknownSideEffect: true,
  });
  const failed = repo.get(task.id);
  assert.equal(failed.state, "failed");
  assert.equal(failed.runs.length, 1);
  assert.equal(failed.runs[0].unknownSideEffect, true);
  assert.equal(repo.claimNext(), null);
});

test("FIFO, cancellation keeps slot until receipt, recovery never reruns unknown side effects", (t) => {
  const repo = fixture(t).tasks,
    one = publish(repo),
    two = publish(repo),
    three = publish(repo);
  const run = repo.claimNext();
  assert.equal(run.task.id, one.id);
  assert.equal(repo.cancel(one.id).state, "cancelling");
  assert.equal(repo.claimNext(), null);
  assert.equal(repo.finishRun(run.id, receipt).state, "cancelled");
  assert.equal(repo.get(one.id).reason, "user_cancelled");
  assert.equal(repo.get(one.id).acceptances.length, 0);
  const next = repo.claimNext();
  assert.equal(next.task.id, two.id);
  repo.reconcile();
  const interrupted = repo.get(two.id);
  assert.equal(interrupted.state, "failed");
  assert.equal(interrupted.runs[0].unknownSideEffect, true);
  assert.equal(repo.claimNext().task.id, three.id);
});
test("a Team that cancels itself closes its Task and all unstarted work", (t) => {
  const repo = fixture(t).tasks,
    task = publish(repo);
  repo.finishRun(repo.claimNext().id, { state: "cancelled", reason: "team_stopped" });
  assert.equal(repo.get(task.id).state, "cancelled");
});

test("v32 cutover assigns new Task identities, preserves provenance and never replays old work", () => {
  const Database = require("better-sqlite3"),
    { applyMigrations } = require("../../src/storage/migrations"),
    { MIGRATIONS } = require("../../src/storage/schema");
  const db = new Database(":memory:");
  try {
    applyMigrations(db, MIGRATIONS.slice(0, 32));
    const threads = require("../../src/storage/thread-repository").createThreadRepository(db);
    threads.create({ id: "old-thread" });
    const old = {
      ...contract,
      workflowId: "software_delivery",
      subtasks: [{ id: "first", title: "First", description: "Produce output" }],
    };
    db.prepare(
      "INSERT INTO collaboration_tasks(thread_id,phase,artifacts_json,created_at,updated_at,version,delegation_state,contract_json,result_json) VALUES (?,'discuss','{}',?,?,1,'running',?,?)"
    ).run(
      "old-thread",
      new Date().toISOString(),
      new Date().toISOString(),
      JSON.stringify(old),
      JSON.stringify({ summary: "partial output" })
    );
    applyMigrations(db);
    const repo = require("../../src/storage/task-repository").createTaskRepository(db),
      task = repo.list()[0];
    assert.notEqual(task.id, "old-thread");
    assert.equal(task.state, "failed");
    assert.equal(task.legacySource.threadId, "old-thread");
    assert.equal(task.legacySource.result.summary, "partial output");
    assert.equal(repo.claimNext(), null);
    assert.equal(task.contract.subtasks[0].workflowId, "software_delivery");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM legacy_delegation_archive").get().n, 1);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

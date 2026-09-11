const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStorage } = require("../../src/storage");
const { createCollabTaskRegistry } = require("../../src/agents/collab-task-registry");
const { processWorkflowEvidenceOutput } = require("../../src/agents/workflow-evidence");
const { projectTaskContext } = require("../../src/storage/collaboration-read-model");

test("progress survives restart, rejects stale evidence and cannot complete a task", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shift-task-updates-"));
  const file = path.join(dir, "db.sqlite");
  let storage = createStorage({ file });
  const registryFor = () => createCollabTaskRegistry({ repository: storage.collaborationTasks });
  try {
    storage.threads.create({ id: "t1", title: "Task" });
    let registry = registryFor();
    const initial = registry.captureUserGoal("t1", { text: "Preserve state", messageId: "m1" });
    registry.captureUserGoal("t1", { text: "Also recover after restart", messageId: "m2" });
    const input = {
      agent: "codex",
      duty: "review",
      invocationId: "i1",
      seatId: "s1",
      threadId: "t1",
      registry,
    };
    const value = {
      goal_hash: initial.goalHash,
      plan_hash: null,
      current: "Review recovery",
      completed: [{ item: "Persist state", evidence: ["commit abc; tests log"] }],
      remaining: ["Restart"],
      blockers: [],
      next_action: "Restart the sandbox",
      verification: ["node --test: passed; commit abc; log /tmp/check"],
    };
    const send = (data, type = "task_progress", extra = {}) =>
      processWorkflowEvidenceOutput({
        ...input,
        registry,
        content: "```" + type + "\n" + JSON.stringify(data) + "\n```",
        ...extra,
      })[0];
    assert.equal(send(value).event, "task-state-updated");
    const version = registry.getTask("t1").version;
    assert.equal(send(value).payload.reused, true);
    assert.equal(registry.getTask("t1").version, version);
    assert.equal(
      send({ ...value, completed: [{ item: "done", evidence: [] }] }).payload.reason,
      "invalid_task_progress"
    );
    assert.equal(send({ ...value, plan_hash: "old" }).payload.reason, "task_plan_mismatch");
    assert.equal(send({ ...value, goal_hash: "old" }).payload.reason, "task_goal_mismatch");
    assert.equal(send({ ...value, status: "accepted" }).payload.reason, "invalid_task_progress");
    assert.notEqual(registry.getTask("t1").taskStatus, "accepted");
    storage.close();
    storage = createStorage({ file });
    registry = registryFor();
    const snapshot = projectTaskContext(registry.getTask("t1"));
    assert.equal(snapshot.progress.next_action, value.next_action);
    assert.equal(snapshot.progress.evidenceLevel, "agent_reported");
    assert.equal(snapshot.userUpdates[0].messageId, "m2");
    assert.equal(send(value).payload.reused, true);
    const revision = {
      goal_hash: initial.goalHash,
      text: "Preserve state and recover",
      source_message_id: "m2",
    };
    assert.equal(
      send(revision, "task_goal").payload.reason,
      "goal_revision_requires_planning_duty"
    );
    assert.equal(
      send({ ...revision, source_message_id: "invented" }, "task_goal", { duty: "discuss" }).payload
        .reason,
      "goal_revision_requires_user_message"
    );
    assert.equal(send(revision, "task_goal", { duty: "discuss" }).event, "task-state-updated");
    const revised = registry.getTask("t1");
    assert.equal(revised.goalOriginal, "Preserve state");
    assert.equal(revised.artifacts.userGoal.text, revision.text);
    assert.equal(revised.artifacts.progress, undefined);
    assert.equal(revised.goalHash, revised.artifacts.userGoal.hash);
    assert.equal(send({ ...value, current: "stale" }).payload.reason, "task_goal_mismatch");
    assert.equal(revised.history.at(-1).actorId, "s1");
    assert.equal(revised.history.at(-1).payload.value.source_message_id, "m2");
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("new plans invalidate reported progress but route changes do not", () => {
  const registry = createCollabTaskRegistry();
  const goal = registry.captureUserGoal("t", { text: "Goal" });
  const plan = {
    summary: "Plan",
    files: ["src/a"],
    changes: ["change a"],
    tests: ["test a"],
    risks: [],
  };
  const first = registry.submitImplementationPlan("t", {
    actorAgentId: "grok",
    actorDuty: "plan",
    plan,
    invocationId: "i1",
  });
  const progress = {
    goal_hash: goal.goalHash,
    plan_hash: first.planHash,
    current: "Working",
    completed: [],
    remaining: [],
    blockers: [],
    next_action: "Review",
    verification: [],
  };
  assert.equal(
    registry.submitTaskUpdate("t", {
      type: "task_progress",
      value: progress,
      actorDuty: "implement",
      actorAgentId: "grok",
      seatId: "s",
      invocationId: "i2",
    }).accepted,
    true
  );
  registry.noteAcceptedRoute({
    threadId: "t",
    fromAgent: "grok",
    toAgent: "codex",
    fromDuty: "implement",
    toDuty: "review",
    intent: "review",
  });
  assert.ok(registry.getTask("t").artifacts.progress);
  registry.submitImplementationPlan("t", {
    actorAgentId: "grok",
    actorDuty: "plan",
    plan: { ...plan, changes: ["new change"] },
    invocationId: "i3",
  });
  assert.equal(registry.getTask("t").artifacts.progress, undefined);
});

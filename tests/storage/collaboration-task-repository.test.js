"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const { createCollabTaskRegistry } = require("../../src/agents/collab-task-registry");

test("collaboration task repository persists phases, artifacts, gates, and events", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shift-collab-task-"));
  const file = path.join(dir, "shift.sqlite");
  let storage = createStorage({ file });
  try {
    storage.threads.create({ id: "thread-1", title: "Collaboration" });
    assert.equal(storage.collaborationTasks.get("thread-1"), null);

    const discuss = storage.collaborationTasks.save(
      {
        threadId: "thread-1",
        phase: "discuss",
        artifacts: {
          userGoal: { text: "Original goal", hash: "goal-v1", version: 1 },
          preliminarySolution: { hash: "draft-v1" },
        },
        goalNormalized: "Normalized goal",
        evidenceProfile: "analysis",
      },
      {
        type: "transition",
        from: "discuss",
        to: "discuss",
        actorAgentId: "gemini",
        actorKind: "human",
        actorId: "user",
        duty: "discuss",
        intent: "discuss",
      }
    );
    assert.equal(discuss.phase, "discuss");
    assert.equal(discuss.artifacts.userGoal.hash, "goal-v1");
    assert.equal(discuss.taskStatus, "active");
    assert.equal(discuss.goalOriginal, "Original goal");
    assert.equal(discuss.goalNormalized, "Normalized goal");
    assert.equal(discuss.goalHash, "goal-v1");
    assert.equal(discuss.evidenceProfile, "analysis");
    assert.equal(discuss.history[0].actorKind, "human");
    assert.equal(discuss.history[0].actorId, "user");
    assert.equal(discuss.history[0].duty, "discuss");
    assert.equal(discuss.history.length, 1);

    const implemented = storage.collaborationTasks.save(
      {
        ...discuss,
        phase: "implement",
        goalOriginal: "Attempted overwrite",
        implementationGate: {
          planHash: "plan-v1",
          approvedBy: "codex",
        },
      },
      {
        type: "transition",
        from: "discuss",
        to: "implement",
        actorAgentId: "codex",
        intent: "implement",
      }
    );
    assert.equal(implemented.phase, "implement");
    assert.equal(implemented.state, "implement");
    assert.equal(implemented.implementationGate.approvedBy, "codex");
    assert.equal(implemented.goalOriginal, "Original goal");
    assert.equal(implemented.history.length, 2);
    assert.equal(implemented.version, 2);

    storage.close();
    storage = createStorage({ file });
    const restored = storage.collaborationTasks.get("thread-1");
    assert.equal(restored.phase, "implement");
    assert.equal(restored.artifacts.userGoal.version, 1);
    assert.equal(restored.implementationGate.planHash, "plan-v1");
    assert.equal(restored.goalOriginal, "Original goal");
    assert.equal(restored.goalHash, "goal-v1");
    assert.equal(restored.evidenceProfile, "analysis");
    assert.deepEqual(
      restored.history.map((event) => event.intent),
      ["discuss", "implement"]
    );

    assert.equal(storage.threads.purge("thread-1"), true);
    assert.equal(storage.collaborationTasks.get("thread-1"), null);
  } finally {
    if (storage?.db?.open) storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("collaboration task repository rejects unknown phases and intents", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    storage.threads.create({ id: "thread-1", title: "Collaboration" });
    assert.throws(
      () => storage.collaborationTasks.save({ threadId: "thread-1", phase: "planning" }),
      /Unsupported collaboration phase/
    );
    assert.throws(
      () =>
        storage.collaborationTasks.save(
          { threadId: "thread-1", phase: "discuss" },
          { type: "route", intent: "ship-it" }
        ),
      /Unsupported handoff intent/
    );
  } finally {
    storage.close();
  }
});

test("a done phase does not synthesize accepted without a Human decision", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    storage.threads.create({ id: "thread-1", title: "Collaboration" });
    const saved = storage.collaborationTasks.save({ threadId: "thread-1", phase: "done" });
    assert.equal(saved.phase, "done");
    assert.equal(saved.taskStatus, "active");
    assert.equal(storage.collaborationTasks.get("thread-1").taskStatus, "active");
  } finally {
    storage.close();
  }
});

test("approved Grok plan hash survives a registry and database restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shift-plan-gate-"));
  const file = path.join(dir, "shift.sqlite");
  let storage = createStorage({ file });
  try {
    storage.threads.create({ id: "thread-plan", title: "Plan gate" });
    let registry = createCollabTaskRegistry({ repository: storage.collaborationTasks });
    registry.ensureImplementationPlanRequired("thread-plan", { requestedBy: "codex" });
    const submitted = registry.submitImplementationPlan("thread-plan", {
      actorAgentId: "grok",
      actorDuty: "plan",
      plan: {
        summary: "Persist plan approval",
        files: ["src/plan.js"],
        changes: ["Store a hash-bound gate"],
        tests: ["node --test tests/plan.test.js"],
        risks: [],
      },
    });
    assert.equal(
      registry.approveImplementationPlan("thread-plan", {
        actorAgentId: "codex",
        actorDuty: "discuss",
        planHash: submitted.planHash,
      }).approved,
      true
    );

    storage.close();
    storage = createStorage({ file });
    registry = createCollabTaskRegistry({ repository: storage.collaborationTasks });
    const restored = registry.implementationPermission("thread-plan");
    assert.equal(restored.allowed, true);
    assert.equal(restored.planHash, submitted.planHash);
    assert.equal(restored.gate.approvedBy, "codex");
  } finally {
    if (storage?.db?.open) storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

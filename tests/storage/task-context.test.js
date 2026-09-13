const assert = require("node:assert/strict");
const test = require("node:test");
const { createStorage } = require("../../src/storage");
const {
  projectTaskContext,
  projectCollaboration,
} = require("../../src/storage/collaboration-read-model");
const { renderTaskContext } = require("../../src/session/bootstrap");

test("each task consumer receives current goal, requirements and plan content from SQLite", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    storage.threads.create({ id: "task-context", title: "Context" });
    const task = storage.collaborationTasks.save({
      threadId: "task-context",
      phase: "implement",
      goalOriginal: "Original user requirement",
      artifacts: {
        userGoal: { text: "Current requirement", hash: "g1", messageId: "m1" },
        solutionBaseline: { summary: "Keep SQLite authoritative", constraints: ["No outbox"] },
        implementationPlan: {
          hash: "p1",
          changes: ["Restore the sealed context"],
          tests: ["Restart test"],
        },
      },
    });
    for (const duty of ["implement", "fix", "review"]) {
      const binding = { duty, seatId: "seat1" };
      const snapshot = projectTaskContext(storage.collaborationTasks.get(task.threadId), binding);
      const prompt = renderTaskContext(snapshot);
      assert.match(prompt, /Original user requirement/);
      assert.match(prompt, /No outbox/);
      assert.match(prompt, /Restore the sealed context/);
      assert.equal(snapshot.currentDuty, duty);
      assert.deepEqual(
        projectCollaboration(task, null, { bindings: [binding] }).taskContext,
        snapshot
      );
    }
    storage.collaborationTasks.save({
      ...task,
      artifacts: { ...task.artifacts, implementationPlan: { hash: "p2", changes: ["New plan"] } },
    });
    const next = projectTaskContext(storage.collaborationTasks.get(task.threadId));
    assert.equal(next.version, task.version + 1);
    assert.match(renderTaskContext(next), /New plan/);
    assert.doesNotMatch(renderTaskContext(next), /Restore the sealed context/);
  } finally {
    storage.close();
  }
});

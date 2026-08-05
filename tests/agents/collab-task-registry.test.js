"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { STATE, createCollabTaskRegistry } = require("../../src/agents/collab-task-registry");

function route(registry, input) {
  return registry.noteAcceptedRoute({
    threadId: "thread-1",
    contentHash: `${input.fromAgent}-${input.toAgent}-${input.intent}`,
    handoff: {
      goal: "deliver the user outcome",
      what: input.what || "continue workflow",
    },
    ...input,
  });
}

test("five-phase registry follows discuss, implement, review, deliver, done", () => {
  const registry = createCollabTaskRegistry();

  assert.equal(
    route(registry, { fromAgent: "codex", toAgent: "gemini", intent: "discuss" }).phase,
    STATE.DISCUSS
  );
  assert.equal(
    route(registry, { fromAgent: "codex", toAgent: "grok", intent: "plan" }).phase,
    STATE.IMPLEMENT
  );
  assert.equal(
    route(registry, { fromAgent: "grok", toAgent: "opencode", intent: "review" }).phase,
    STATE.REVIEW
  );
  const delivered = route(registry, {
    fromAgent: "opencode",
    toAgent: "codex",
    intent: "accept",
    what: "approve: diff reviewed and ready for delivery",
  });
  assert.equal(delivered.phase, STATE.DELIVER);
  assert.equal(delivered.codeReviewGate.reviewedBy, "opencode");

  const blocked = registry.markDone("thread-1", { actorAgentId: "codex" });
  assert.equal(blocked.phase, STATE.DELIVER);
  assert.equal(blocked.completionBlocked, "delivery_not_bound_to_review");

  registry.updateTask("thread-1", {
    deliveryGate: {
      commitSha: "abc123",
      ciStatus: "success",
      reviewEvidenceHash: delivered.codeReviewGate.evidenceHash,
    },
    finalGate: { verdict: "accept", acceptedCommitSha: "abc123" },
  });
  assert.equal(registry.markDone("thread-1", { actorAgentId: "codex" }).phase, STATE.DONE);
});

test("OpenCode review changes return to implement and invalidate downstream gates", () => {
  const registry = createCollabTaskRegistry();
  route(registry, { fromAgent: "codex", toAgent: "grok", intent: "implement" });
  route(registry, { fromAgent: "grok", toAgent: "opencode", intent: "review" });
  const task = route(registry, {
    fromAgent: "opencode",
    toAgent: "grok",
    intent: "fix",
    what: "request-changes: P1 missing boundary test",
  });

  assert.equal(task.phase, STATE.IMPLEMENT);
  assert.equal(task.codeReviewGate, null);
  assert.equal(task.deliveryGate, null);
  assert.equal(task.finalGate, null);
});

test("explicit discussion intent remains discuss even when the session uses a worktree", () => {
  const registry = createCollabTaskRegistry();
  const task = route(registry, {
    fromAgent: "codex",
    toAgent: "gemini",
    intent: "discuss",
    useWorktree: true,
  });
  assert.equal(task.phase, STATE.DISCUSS);
});

test("persistent registry delegates state and event writes to its repository", () => {
  const stored = new Map();
  const repository = {
    get: (id) => stored.get(id) || null,
    save(task, event) {
      const history = [...(task.history || []), ...(event ? [event] : [])];
      const saved = { ...task, version: Number(task.version || 0) + 1, history };
      stored.set(task.threadId, saved);
      return saved;
    },
  };
  const first = createCollabTaskRegistry({ repository });
  route(first, { fromAgent: "codex", toAgent: "grok", intent: "plan" });

  const afterRestart = createCollabTaskRegistry({ repository });
  assert.equal(afterRestart.getTask("thread-1").phase, STATE.IMPLEMENT);
  assert.equal(afterRestart.getTask("thread-1").history.length, 1);
});

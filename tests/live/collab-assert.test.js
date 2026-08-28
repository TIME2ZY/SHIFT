"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildCollabSlicePrompt,
  evaluateCollaboration,
  evaluateAcceptedHandoff,
  evaluateTerminalInvocations,
  evaluateCleanWorkspace,
  evaluateSnapshotStable,
} = require("../../scripts/live/lib/collab-assert");

test("collab slice prompt forbids implementation and asks Grok for a plan", () => {
  const prompt = buildCollabSlicePrompt("utcOffset mutates the original instance");
  assert.match(prompt, /@Grok/);
  assert.match(prompt, /implementation_plan/);
  assert.match(prompt, /不要改任何文件/);
  assert.match(prompt, /utcOffset mutates the original instance/);
});

test("collaboration requires an implement phase with a plan hash", () => {
  assert.equal(evaluateCollaboration(null).ok, false);
  assert.ok(
    evaluateCollaboration({ phase: "discuss", implementation: {} }).problems.includes(
      "plan_fence_missing"
    )
  );
  assert.equal(
    evaluateCollaboration({
      phase: "implement",
      implementation: { planHash: "plan-1", status: "pending_approval" },
    }).ok,
    true
  );
});

test("accepted handoff must bind a target invocation", () => {
  assert.equal(evaluateAcceptedHandoff([]).ok, false);
  assert.equal(
    evaluateAcceptedHandoff([
      { routeStatus: "accepted", targetInvocationId: "inv-2", targetAgent: "grok" },
    ]).ok,
    true
  );
});

test("invocations must include terminal Codex and Grok hops", () => {
  assert.equal(evaluateTerminalInvocations([{ agentId: "codex", state: "completed" }]).ok, false);
  assert.equal(
    evaluateTerminalInvocations([
      { agentId: "codex", state: "completed" },
      { agentId: "grok", state: "completed" },
    ]).ok,
    true
  );
  assert.equal(
    evaluateTerminalInvocations([
      { agentId: "codex", state: "completed" },
      { agentId: "grok", state: "active" },
    ]).ok,
    false
  );
});

test("plan-only slice fails when the project or worktree has edits", () => {
  assert.equal(evaluateCleanWorkspace({ projectFiles: [], worktreeDiff: "" }).ok, true);
  assert.equal(evaluateCleanWorkspace({ projectFiles: ["src/index.js"] }).ok, false);
  assert.equal(evaluateCleanWorkspace({ worktreeDiff: "diff --git a/src/index.js" }).ok, false);
});

test("refresh keeps the same durable plan hash", () => {
  const pending = { phase: "implement", implementation: { planHash: "plan-1" } };
  assert.equal(evaluateSnapshotStable(pending, pending).ok, true);
  assert.equal(
    evaluateSnapshotStable(pending, { phase: "implement", implementation: { planHash: "other" } })
      .ok,
    false
  );
});

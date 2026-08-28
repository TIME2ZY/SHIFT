"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { projectCollaboration } = require("../../src/storage/collaboration-read-model");

test("null task projects to null", () => {
  assert.equal(projectCollaboration(null), null);
  assert.equal(projectCollaboration(undefined), null);
});

test("discuss without a plan gate has no implementation blocker", () => {
  const snapshot = projectCollaboration({
    phase: "discuss",
    goal: "Ship the workflow",
    lastFrom: "codex",
    lastTo: "gemini",
    updatedAt: "2026-08-27T00:00:00.000Z",
    artifacts: {},
  });
  assert.equal(snapshot.phase, "discuss");
  assert.equal(snapshot.implementation.status, null);
  assert.equal(snapshot.implementation.allowed, null);
  assert.equal(snapshot.blocker, null);
  assert.equal(snapshot.review.status, null);
  assert.equal(snapshot.delivery.status, null);
  assert.equal(snapshot.acceptance.status, null);
});

test("pending plan projects status, summary, and blocker without dumping the plan body", () => {
  const snapshot = projectCollaboration(
    {
      phase: "implement",
      goal: "Fix utcOffset clone",
      lastFrom: "codex",
      lastTo: "grok",
      updatedAt: "2026-08-27T01:00:00.000Z",
      implementationGate: {
        status: "pending_approval",
        planHash: "plan-1",
      },
      artifacts: {
        implementationPlan: {
          hash: "plan-1",
          summary: "Clone before mutating utcOffset",
          files: ["src/index.js"],
          changes: ["Do not mutate the original instance"],
          tests: ["utcOffset clone regression"],
        },
      },
    },
    {
      allowed: false,
      reason: "implementation_plan_not_approved",
      status: "pending_approval",
      planHash: "plan-1",
    }
  );
  assert.equal(snapshot.phase, "implement");
  assert.deepEqual(snapshot.implementation, {
    status: "pending_approval",
    allowed: false,
    reason: "implementation_plan_not_approved",
    planHash: "plan-1",
    summary: "Clone before mutating utcOffset",
  });
  assert.equal(snapshot.blocker, "implementation_plan_not_approved");
  assert.equal(JSON.stringify(snapshot).includes("src/index.js"), false);
});

test("approved plan clears the implementation blocker", () => {
  const snapshot = projectCollaboration(
    {
      phase: "implement",
      implementationGate: { status: "approved", planHash: "plan-2" },
      artifacts: { implementationPlan: { hash: "plan-2", summary: "Ready" } },
    },
    { allowed: true, reason: null, status: "approved", planHash: "plan-2" }
  );
  assert.equal(snapshot.implementation.allowed, true);
  assert.equal(snapshot.implementation.reason, null);
  assert.equal(snapshot.blocker, null);
});

test("deliver without final acceptance reports a derived blocker", () => {
  const snapshot = projectCollaboration({
    phase: "deliver",
    codeReviewGate: { verdict: "approve", evidenceHash: "rev-1" },
    deliveryGate: {
      commitSha: "abc123",
      prUrl: "https://example.test/pr/1",
      ciStatus: "success",
    },
    artifacts: {},
  });
  assert.equal(snapshot.review.status, "approved");
  assert.equal(snapshot.delivery.status, "verified");
  assert.equal(snapshot.acceptance.status, null);
  assert.equal(snapshot.blocker, "final_acceptance_missing");
});

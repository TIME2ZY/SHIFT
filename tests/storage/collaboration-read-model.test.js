"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  projectCollaboration,
  projectSeats,
} = require("../../src/storage/collaboration-read-model");

const seats = [
  { seatId: "seat-codex", providerId: "codex", label: "主席", enabled: true },
  { seatId: "seat-gemini", providerId: "gemini", label: null, enabled: true },
];

test("null task projects to null while enabled seats remain independently readable", () => {
  assert.equal(projectCollaboration(null), null);
  assert.deepEqual(
    projectSeats([...seats, { seatId: "off", providerId: "grok", enabled: false }]),
    [
      { seatId: "seat-codex", providerId: "codex", label: "主席" },
      { seatId: "seat-gemini", providerId: "gemini", label: null },
    ]
  );
});

test("task card projects goal, current Duty binding, workspace evidence, and next action", () => {
  const snapshot = projectCollaboration(
    {
      phase: "implement",
      taskStatus: "active",
      goalOriginal: "修复时区问题",
      goalNormalized: "Clone before mutating utcOffset",
      updatedAt: "2026-08-27T01:00:00.000Z",
      implementationGate: { status: "approved", planHash: "plan-1" },
      artifacts: { implementationPlan: { hash: "plan-1", summary: "Clone first" } },
    },
    { allowed: true, status: "approved", planHash: "plan-1" },
    {
      seats,
      bindings: [
        {
          seatId: "seat-codex",
          duty: "implement",
          skillName: "implementation-plan",
          enforcementLevel: "enforced",
        },
      ],
      workspace: { headSha: "a".repeat(40), porcelain: [" M src/index.js"] },
    }
  );

  assert.equal(snapshot.goalOriginal, "修复时区问题");
  assert.equal(snapshot.goalNormalized, "Clone before mutating utcOffset");
  assert.deepEqual(snapshot.currentSeat, {
    seatId: "seat-codex",
    providerId: "codex",
    label: "主席",
  });
  assert.equal(snapshot.currentDuty, "implement");
  assert.equal(snapshot.currentSkill, "implementation-plan");
  assert.deepEqual(snapshot.evidence, {
    dirtyFileCount: 1,
    headSha: "a".repeat(40),
    commitSha: null,
    prUrl: null,
    ciStatus: null,
  });
  assert.equal(snapshot.nextAction, "完成实现并留下验证证据。");
  assert.equal(snapshot.blocker, null);
});

test("pending plan projects a categorized approval blocker without dumping the plan body", () => {
  const snapshot = projectCollaboration(
    {
      phase: "implement",
      goalOriginal: "Fix utcOffset clone",
      implementationGate: { status: "pending_approval", planHash: "plan-1" },
      artifacts: {
        implementationPlan: {
          hash: "plan-1",
          summary: "Clone before mutating utcOffset",
          files: ["src/index.js"],
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

  assert.deepEqual(snapshot.blocker, {
    type: "waiting_approval",
    reason: "implementation_plan_not_approved",
  });
  assert.equal(snapshot.nextAction, "请批准实现方案后继续。");
  assert.equal(JSON.stringify(snapshot).includes("src/index.js"), false);
});

test("review mode compares implementer and reviewer Duty bindings", () => {
  const task = {
    phase: "deliver",
    codeReviewGate: { verdict: "approve", evidenceHash: "rev-1" },
    deliveryGate: {
      commitSha: "b".repeat(40),
      prUrl: "https://example.test/pr/1",
      ciStatus: "success",
    },
    artifacts: {},
  };
  const implement = { seatId: "seat-codex", duty: "implement" };
  const sameSeat = projectCollaboration(task, null, {
    bindings: [implement, { seatId: "seat-codex", duty: "review" }],
  });
  const otherSeat = projectCollaboration(task, null, {
    bindings: [implement, { seatId: "seat-gemini", duty: "review" }],
  });

  assert.equal(sameSeat.reviewMode, "same_seat");
  assert.equal(otherSeat.reviewMode, "other_seat");
  assert.deepEqual(otherSeat.blocker, {
    type: "waiting_human",
    reason: "final_acceptance_missing",
  });
  assert.equal(otherSeat.evidence.commitSha, "b".repeat(40));
});

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
  assert.equal(snapshot.nextAction, "请由讨论或验收席位批准方案后继续。");
  assert.equal(JSON.stringify(snapshot).includes("src/index.js"), false);
});

test("approved review without delivery is waiting for evidence, not unreviewed", () => {
  const snapshot = projectCollaboration(
    {
      phase: "review",
      taskStatus: "active",
      codeReviewGate: { verdict: "approve", evidenceHash: "rev-1" },
      artifacts: { codeReview: { hash: "rev-1" } },
    },
    { allowed: true, status: "approved", planHash: "plan-1" },
    {
      bindings: [
        { seatId: "seat-grok", duty: "implement" },
        { seatId: "seat-codex", duty: "review" },
      ],
    }
  );
  assert.equal(snapshot.reviewMode, "other_seat");
  assert.equal(snapshot.acceptance.reviewVerdict, "approved");
  assert.deepEqual(snapshot.blocker, {
    type: "missing_evidence",
    reason: "delivery_evidence_missing",
  });
  assert.equal(snapshot.nextAction, "请补充 commit、PR 和 CI 交付证据。");
});

test("changes requested keep an explicit review blocker through the fix hop", () => {
  const snapshot = projectCollaboration(
    {
      phase: "implement",
      codeReviewGate: { verdict: "changes_requested", evidenceHash: "rev-2" },
      artifacts: { codeReview: { hash: "rev-2" } },
    },
    { allowed: true, status: "approved" },
    {
      bindings: [
        { seatId: "seat-grok", duty: "implement" },
        { seatId: "seat-codex", duty: "review" },
        { seatId: "seat-grok", duty: "fix" },
      ],
    }
  );
  assert.equal(snapshot.reviewMode, "other_seat");
  assert.equal(snapshot.acceptance.reviewVerdict, "changes_requested");
  assert.deepEqual(snapshot.blocker, {
    type: "missing_evidence",
    reason: "code_review_changes_requested",
  });
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
    type: "missing_evidence",
    reason: "final_acceptance_missing",
  });
  assert.equal(otherSeat.evidence.commitSha, "b".repeat(40));
});

test("acceptance card exposes the bound goal, plan, Git, CI, and Seat verdict", () => {
  const commitSha = "c".repeat(40);
  const snapshot = projectCollaboration(
    {
      phase: "done",
      taskStatus: "accepted",
      artifacts: {
        userGoal: { hash: "goal-hash-1" },
        implementationPlan: { hash: "plan-hash-1" },
        acceptanceDecision: {
          verdict: "accepted",
          goalHash: "goal-hash-1",
          planHash: "plan-hash-1",
          commitSha,
          decidedAt: "2026-09-04T00:00:00.000Z",
        },
      },
      implementationGate: { approvedPlanHash: "plan-hash-1" },
      codeReviewGate: { verdict: "approve", evidenceHash: "review-1" },
      deliveryGate: {
        commitSha,
        branch: "codex/acceptance",
        prUrl: "https://example.test/pr/7",
        ciStatus: "success",
      },
    },
    null,
    {
      acceptanceReadiness: { ok: true, reason: null },
      workspace: { branch: "codex/acceptance", headSha: commitSha },
      bindings: [
        { seatId: "seat-codex", duty: "implement" },
        { seatId: "seat-codex", duty: "review" },
      ],
    }
  );

  assert.equal(snapshot.status, "accepted");
  assert.equal(snapshot.blocker, null);
  assert.deepEqual(snapshot.acceptance, {
    evidenceProfile: "code_change",
    goalHash: "goal-hash-1",
    planHash: "plan-hash-1",
    branch: "codex/acceptance",
    headSha: commitSha,
    commitSha,
    prUrl: "https://example.test/pr/7",
    ciStatus: "success",
    reviewMode: "same_seat",
    reviewVerdict: "approved",
    verdict: "accepted",
    ready: true,
    reason: null,
    decidedAt: "2026-09-04T00:00:00.000Z",
  });
});

test("legacy done state and stale Seat decisions cannot project as accepted", () => {
  const commitSha = "d".repeat(40);
  const legacy = projectCollaboration(
    { phase: "done", taskStatus: "accepted", artifacts: {}, deliveryGate: { commitSha } },
    null,
    { acceptanceReadiness: { ok: true, reason: null } }
  );
  assert.equal(legacy.status, "active");
  assert.equal(legacy.acceptance.verdict, "incomplete");
  assert.deepEqual(legacy.blocker, {
    type: "missing_evidence",
    reason: "final_acceptance_missing",
  });

  const stale = projectCollaboration(
    {
      phase: "done",
      taskStatus: "accepted",
      artifacts: {
        userGoal: { hash: "new-goal" },
        implementationPlan: { hash: "plan-1" },
        acceptanceDecision: {
          verdict: "accepted",
          goalHash: "old-goal",
          planHash: "plan-1",
          commitSha,
        },
      },
      implementationGate: { approvedPlanHash: "plan-1" },
      deliveryGate: { commitSha, ciStatus: "success" },
    },
    null,
    { acceptanceReadiness: { ok: true, reason: null } }
  );
  assert.equal(stale.status, "active");
  assert.equal(stale.acceptance.verdict, "incomplete");
  assert.equal(stale.acceptance.reason, "final_acceptance_missing");
});

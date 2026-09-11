"use strict";
const { parseTaskUpdates } = require("./task-updates");

const {
  parseImplementationPlan,
  parseSolutionBaseline,
  parseCodeReview,
  parseDeliveryReceipt,
  parseFinalAcceptance,
} = require("./workflow-gates");

function processWorkflowEvidenceOutput(input = {}) {
  const agent = String(input.agent || "").toLowerCase();
  const duty = String(input.duty || "").toLowerCase();
  const content = String(input.content || "");
  const threadId = input.threadId;
  const registry = input.registry;
  const events = [];
  if (!threadId || !registry) return events;

  for (const update of parseTaskUpdates(content)) {
    const result = registry.submitTaskUpdate(threadId, {
      ...update,
      actorAgentId: agent,
      actorDuty: duty,
      invocationId: input.invocationId,
      seatId: input.seatId,
    });
    events.push({
      event: result.accepted ? "task-state-updated" : "task-state-rejected",
      payload: { ...summarize(result, ["reused"]), version: result.task?.version },
    });
  }

  if (["discuss", "plan", "accept"].includes(duty)) {
    const baseline = parseSolutionBaseline(content);
    if (baseline) {
      const result = registry.submitSolutionBaseline(threadId, {
        actorAgentId: agent,
        actorDuty: duty,
        baseline,
      });
      events.push({
        event: result.accepted ? "solution-baseline-submitted" : "solution-baseline-rejected",
        payload: summarize(result, ["solutionHash", "reused"]),
      });
    }

    const acceptance = duty === "accept" ? parseFinalAcceptance(content) : null;
    if (acceptance) {
      const result = registry.submitFinalAcceptance(threadId, {
        actorAgentId: agent,
        actorDuty: duty,
        acceptance,
      });
      events.push({
        event: result.accepted ? "final-acceptance-submitted" : "final-acceptance-rejected",
        payload: summarize(result, ["verdict", "acceptanceHash", "taskStatus", "reason"]),
      });
    }
  }

  if (["plan", "implement", "fix"].includes(duty)) {
    const plan = parseImplementationPlan(content);
    if (plan || !registry.implementationPermission(threadId).allowed) {
      const result = registry.submitImplementationPlan(threadId, {
        actorAgentId: agent,
        actorDuty: duty,
        plan,
        invocationId: input.invocationId,
        progressKey: input.progressKey,
        maxPlanRepeats: input.maxPlanRepeats,
      });
      events.push({
        event: result.accepted
          ? "implementation-plan-submitted"
          : result.loopDetected
            ? "implementation-plan-loop-detected"
            : "implementation-plan-required",
        payload: summarize(result, [
          "planHash",
          "isomorphicHash",
          "reused",
          "loopDetected",
          "consecutiveRepeats",
        ]),
      });
      if (result.loopDetected) {
        events.push({
          event: "plan-warning",
          payload: {
            warning: "duplicate_plan_loop_detected",
            planHash: result.planHash,
            isomorphicHash: result.isomorphicHash,
            consecutiveRepeats: result.consecutiveRepeats,
            message: `连续生成相同或同构实现方案超过限制 (${result.consecutiveRepeats} 次)，已主动终止循环。`,
          },
        });
      }
    }
  }

  if (["review", "deliver"].includes(duty)) {
    let review = parseCodeReview(content);
    const receipt = parseDeliveryReceipt(content);
    if (review) {
      const recorded = registry.recordCodeReview(threadId, {
        actorAgentId: agent,
        actorDuty: duty,
        review,
        invocationId: input.invocationId,
        progressKey: input.progressKey,
        maxReviewRepeats: input.maxReviewRepeats,
      });
      if (recorded.reused && recorded.task?.artifacts?.codeReview)
        review = recorded.task.artifacts.codeReview;
      events.push({
        event: recorded.accepted
          ? review.verdict === "approve"
            ? "code-review-approved"
            : "code-review-changes-requested"
          : recorded.loopDetected
            ? "code-review-loop-detected"
            : "code-review-rejected",
        payload: summarize(recorded, [
          "verdict",
          "reviewEvidenceHash",
          "reused",
          "loopDetected",
          "consecutiveRepeats",
        ]),
      });
      if (recorded.loopDetected) {
        events.push({
          event: "plan-warning",
          payload: {
            warning: "duplicate_review_loop_detected",
            verdict: recorded.verdict,
            reviewEvidenceHash: recorded.reviewEvidenceHash,
            consecutiveRepeats: recorded.consecutiveRepeats,
            message: `连续生成相同审查结论超过限制 (${recorded.consecutiveRepeats} 次)，已主动终止循环。`,
          },
        });
      }
    }
    if (review?.verdict === "approve" && receipt) {
      if (!input.deliveryVerifier || typeof input.deliveryVerifier.verify !== "function") {
        events.push({
          event: "delivery-evidence-rejected",
          payload: { accepted: false, reason: "delivery_verifier_unavailable" },
        });
      } else {
        const verification = input.deliveryVerifier.verify({
          cwd: input.cwd,
          branch: input.branch,
          receipt,
        });
        const result = registry.recordDeliveryEvidence(threadId, {
          invocationId: input.invocationId,
          actorAgentId: agent,
          actorDuty: duty,
          review,
          receipt,
          verification,
        });
        events.push({
          event: result.accepted ? "delivery-evidence-verified" : "delivery-evidence-rejected",
          payload: summarize(result, ["readyForAcceptance", "reviewEvidenceHash"]),
        });
      }
    }
  }

  return events;
}

function summarize(result, extraFields) {
  const payload = {
    accepted: Boolean(result?.accepted),
    reason: result?.reason || null,
  };
  for (const field of extraFields || []) {
    if (result && result[field] !== undefined) payload[field] = result[field];
  }
  return payload;
}

module.exports = {
  processWorkflowEvidenceOutput,
};

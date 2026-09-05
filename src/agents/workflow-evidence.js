"use strict";

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
        payload: summarize(result, ["verdict", "acceptanceHash"]),
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
      });
      events.push({
        event: result.accepted ? "implementation-plan-submitted" : "implementation-plan-required",
        payload: summarize(result, ["planHash", "reused"]),
      });
    }
  }

  if (["review", "deliver"].includes(duty)) {
    const review = parseCodeReview(content);
    const receipt = parseDeliveryReceipt(content);
    if (review?.verdict === "approve") {
      if (!receipt) {
        events.push({
          event: "delivery-evidence-rejected",
          payload: { accepted: false, reason: "invalid_or_missing_delivery_receipt" },
        });
      } else if (!input.deliveryVerifier || typeof input.deliveryVerifier.verify !== "function") {
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
    } else if (review) {
      events.push({
        event: "code-review-changes-requested",
        payload: { accepted: true, verdict: review.verdict, summary: review.summary },
      });
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

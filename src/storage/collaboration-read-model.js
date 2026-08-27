/**
 * Session-scoped collaboration snapshot.
 *
 * Pure projection of the SQLite collaboration task plus the current
 * implementation permission. Not a write path and not a second truth source.
 */

"use strict";

function projectCollaboration(task, permission = null) {
  if (!task) return null;
  const implPermission = permission && typeof permission === "object" ? permission : {};
  const implementationGate = task.implementationGate || null;
  const plan = task.artifacts?.implementationPlan || null;
  const reviewGate = task.codeReviewGate || null;
  const deliveryGate = task.deliveryGate || null;
  const finalGate = task.finalGate || null;
  const implementation = projectImplementation(implementationGate, plan, implPermission);

  return {
    phase: String(task.phase || task.state || "discuss"),
    goal: nullableString(task.goal),
    lastFrom: nullableString(task.lastFrom),
    lastTo: nullableString(task.lastTo),
    updatedAt: nullableString(task.updatedAt),
    implementation,
    review: {
      status: reviewGate ? reviewStatus(reviewGate.verdict) : null,
      verdict: nullableString(reviewGate?.verdict),
    },
    delivery: {
      status: deliveryStatus(deliveryGate),
      commitSha: nullableString(deliveryGate?.commitSha),
      prUrl: nullableString(deliveryGate?.prUrl),
      ciStatus: nullableString(deliveryGate?.ciStatus),
    },
    acceptance: {
      status: acceptanceStatus(finalGate),
      verdict: nullableString(finalGate?.verdict),
    },
    blocker: deriveBlocker(task, implementation),
  };
}

function projectImplementation(gate, plan, permission) {
  if (!gate) {
    return {
      status: null,
      allowed: null,
      reason: null,
      planHash: null,
      summary: nullableString(plan?.summary),
    };
  }
  const allowed = permission.allowed === true;
  return {
    status: nullableString(permission.status || gate.status),
    allowed,
    reason: allowed ? null : nullableString(permission.reason),
    planHash: nullableString(permission.planHash || gate.planHash),
    summary: nullableString(plan?.summary),
  };
}

function deriveBlocker(task, implementation) {
  const phase = String(task.phase || task.state || "");
  if (phase === "done") return null;
  if (implementation.status && implementation.allowed === false && implementation.reason) {
    return implementation.reason;
  }
  if (phase === "review" && !task.codeReviewGate) return "code_review_pending";
  if (phase === "deliver") {
    if (!task.deliveryGate) return "delivery_evidence_missing";
    if (task.deliveryGate.ciStatus && task.deliveryGate.ciStatus !== "success") {
      return "ci_not_successful";
    }
    if (!task.finalGate || task.finalGate.verdict !== "accept") {
      return "final_acceptance_missing";
    }
  }
  return null;
}

function reviewStatus(verdict) {
  const value = nullableString(verdict);
  if (value === "approve") return "approved";
  if (value === "changes_requested") return "changes_requested";
  return value;
}

function deliveryStatus(gate) {
  if (!gate) return null;
  if (gate.ciStatus === "success") return "verified";
  if (gate.commitSha || gate.prUrl) return "recorded";
  return "recorded";
}

function acceptanceStatus(gate) {
  if (!gate) return null;
  if (gate.verdict === "accept") return "accepted";
  if (gate.verdict === "reject") return "rejected";
  return "recorded";
}

function nullableString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

module.exports = { projectCollaboration };

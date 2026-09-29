/**
 * Field vocabulary for agent-authored fenced packets.
 *
 * This is the single source: the parsers in `src/agents` and the display
 * registry in `web/src/shared/contracts/contract-fence.ts` both declare against
 * it, so a field cannot be added to a skill and silently missed on either side.
 * The authoring grammar itself lives in `skills/<name>/SKILL.md`.
 *
 * `delivery_receipt` and `implementation_plan` are deliberately included even
 * though the UI is the only consumer of some of them: a fence an agent can be
 * told to emit must have a name here, or it renders as an unlabelled source
 * block.
 *
 * @see docs/decisions/002-multi-agent-reliability-contracts.md
 */

"use strict";

/** A fence and the fields its body may carry, split by whether they repeat. */
function defineFence(fence, spec) {
  return Object.freeze({
    fence,
    scalars: Object.freeze(spec.scalars.slice()),
    lists: Object.freeze(spec.lists.slice()),
    required: Object.freeze((spec.required || []).slice()),
    recommended: Object.freeze((spec.recommended || []).slice()),
    resume: Object.freeze((spec.resume || []).slice()),
  });
}

const HANDOFF = defineFence("handoff", {
  scalars: ["to", "intent", "goal", "what", "why", "tradeoff", "next_action"],
  lists: ["open_questions", "files", "evidence", "constraints", "prohibited"],
  required: ["what", "why", "next_action"],
  recommended: ["to", "intent", "goal", "tradeoff", "open_questions"],
  // Resume intents cannot see the predecessor's tool transcript: these fields
  // are the only evidence they get.
  resume: ["files", "evidence"],
});

const SOLUTION_BASELINE = defineFence("solution_baseline", {
  scalars: ["user_goal_hash", "summary"],
  lists: ["constraints", "non_goals", "acceptance_criteria"],
  required: ["user_goal_hash", "summary", "constraints", "non_goals", "acceptance_criteria"],
});

const IMPLEMENTATION_PLAN = defineFence("implementation_plan", {
  scalars: ["summary"],
  lists: ["files", "changes", "tests", "risks"],
  required: ["summary", "files", "changes", "tests"],
});

const CODE_REVIEW = defineFence("code_review", {
  scalars: ["verdict", "summary"],
  lists: ["findings", "tests"],
  required: ["verdict", "summary", "findings", "tests"],
});

const DELIVERY_RECEIPT = defineFence("delivery_receipt", {
  scalars: ["commit_sha", "pr_url", "base_branch"],
  lists: ["verification"],
  required: ["commit_sha", "pr_url", "base_branch", "verification"],
});

const FINAL_ACCEPTANCE = defineFence("final_acceptance", {
  scalars: ["verdict", "user_goal_hash", "solution_hash", "implementation_plan_hash", "commit_sha"],
  lists: ["checks", "gaps"],
  required: [
    "verdict",
    "user_goal_hash",
    "solution_hash",
    "implementation_plan_hash",
    "commit_sha",
    "checks",
    "gaps",
  ],
});

const TASK_PROGRESS = defineFence("task_progress", {
  scalars: ["goal_hash", "plan_hash", "current", "next_action"],
  lists: ["completed", "remaining", "blockers", "verification"],
  required: ["goal_hash", "current", "next_action", "completed", "remaining", "blockers"],
});

const TASK_GOAL = defineFence("task_goal", {
  scalars: ["goal_hash", "text", "source_message_id"],
  lists: [],
  required: ["goal_hash", "text", "source_message_id"],
});

const FENCES = Object.freeze([
  HANDOFF,
  SOLUTION_BASELINE,
  IMPLEMENTATION_PLAN,
  CODE_REVIEW,
  DELIVERY_RECEIPT,
  FINAL_ACCEPTANCE,
  TASK_PROGRESS,
  TASK_GOAL,
]);

/** Every fence language this vocabulary covers. */
const FENCE_LANGS = Object.freeze(FENCES.map((entry) => entry.fence));

const BY_FENCE = Object.freeze(Object.fromEntries(FENCES.map((entry) => [entry.fence, entry])));

/** Fields of one fence; unknown fence names yield empty sets rather than throwing. */
function fenceFields(fence) {
  const entry = BY_FENCE[fence];
  return entry || { fence, scalars: [], lists: [], required: [], recommended: [], resume: [] };
}

/**
 * Every key a body may carry, required or not. Validators use this to reject a
 * packet with a field the grammar does not define.
 */
function fenceAllowedKeys(fence) {
  const entry = fenceFields(fence);
  return [...entry.scalars, ...entry.lists];
}

module.exports = {
  HANDOFF,
  SOLUTION_BASELINE,
  IMPLEMENTATION_PLAN,
  CODE_REVIEW,
  DELIVERY_RECEIPT,
  FINAL_ACCEPTANCE,
  TASK_PROGRESS,
  TASK_GOAL,
  FENCES,
  FENCE_LANGS,
  fenceFields,
  fenceAllowedKeys,
};

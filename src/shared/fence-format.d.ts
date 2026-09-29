/**
 * Type mirror of `fence-format.js`.
 *
 * Each fence declares its field names as a literal union so the web display
 * registry must label every one of them: adding a field to a skill and to
 * `fence-format.js` becomes a compile error in `web/` until the UI names it,
 * instead of silently falling back to a raw source block.
 *
 * Runtime values live in `fence-format.js`; `web/tsconfig.json` sets
 * `allowJs: false`, so the web consumes names through this file only.
 */

export interface FenceVocabulary {
  readonly fence: string;
  readonly scalars: readonly string[];
  readonly lists: readonly string[];
  readonly required: readonly string[];
  readonly recommended: readonly string[];
  readonly resume: readonly string[];
}

export type HandoffScalarField =
  "to" | "intent" | "goal" | "what" | "why" | "tradeoff" | "next_action";

export type HandoffListField =
  "open_questions" | "files" | "evidence" | "constraints" | "prohibited";

export type SolutionBaselineScalarField = "user_goal_hash" | "summary";
export type SolutionBaselineListField = "constraints" | "non_goals" | "acceptance_criteria";

export type ImplementationPlanScalarField = "summary";
export type ImplementationPlanListField = "files" | "changes" | "tests" | "risks";

export type CodeReviewScalarField = "verdict" | "summary";
export type CodeReviewListField = "findings" | "tests";

export type DeliveryReceiptScalarField = "commit_sha" | "pr_url" | "base_branch";
export type DeliveryReceiptListField = "verification";

export type FinalAcceptanceScalarField =
  "verdict" | "user_goal_hash" | "solution_hash" | "implementation_plan_hash" | "commit_sha";
export type FinalAcceptanceListField = "checks" | "gaps";

export type TaskProgressScalarField = "goal_hash" | "plan_hash" | "current" | "next_action";
export type TaskProgressListField = "completed" | "remaining" | "blockers" | "verification";

export type TaskGoalScalarField = "goal_hash" | "text" | "source_message_id";
export type TaskGoalListField = never;

/** Field names per fence language. The web registry is checked against this. */
export interface FenceFieldMap {
  handoff: { scalars: HandoffScalarField; lists: HandoffListField };
  solution_baseline: {
    scalars: SolutionBaselineScalarField;
    lists: SolutionBaselineListField;
  };
  implementation_plan: {
    scalars: ImplementationPlanScalarField;
    lists: ImplementationPlanListField;
  };
  code_review: { scalars: CodeReviewScalarField; lists: CodeReviewListField };
  delivery_receipt: {
    scalars: DeliveryReceiptScalarField;
    lists: DeliveryReceiptListField;
  };
  final_acceptance: {
    scalars: FinalAcceptanceScalarField;
    lists: FinalAcceptanceListField;
  };
  task_progress: { scalars: TaskProgressScalarField; lists: TaskProgressListField };
  task_goal: { scalars: TaskGoalScalarField; lists: TaskGoalListField };
}

export type FenceLang = keyof FenceFieldMap;

export declare const HANDOFF: FenceVocabulary;
export declare const SOLUTION_BASELINE: FenceVocabulary;
export declare const IMPLEMENTATION_PLAN: FenceVocabulary;
export declare const CODE_REVIEW: FenceVocabulary;
export declare const DELIVERY_RECEIPT: FenceVocabulary;
export declare const FINAL_ACCEPTANCE: FenceVocabulary;
export declare const TASK_PROGRESS: FenceVocabulary;
export declare const TASK_GOAL: FenceVocabulary;
export declare const FENCES: readonly FenceVocabulary[];
export declare const FENCE_LANGS: readonly string[];
export declare function fenceFields(fence: string): FenceVocabulary;
export declare function fenceAllowedKeys(fence: FenceLang | string): string[];

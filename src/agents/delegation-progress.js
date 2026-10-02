"use strict";

// Derived from accepted task evidence or goal/plan-bound Agent reports; never a write authority.
function delegationProgress(task) {
  const report = task.artifacts?.progress;
  const valid =
    report?.goal_hash === task.goalHash &&
    report?.plan_hash === (task.artifacts?.implementationPlan?.hash || null);
  return {
    blockers: valid ? report.blockers : [],
    items: (task.contract?.subtasks || []).map((item) => {
      const completed = valid && report.completed.find((entry) => entry.item === item.id);
      return {
        id: item.id,
        state:
          task.delegationState === "completed"
            ? "accepted"
            : completed
              ? "reported_complete"
              : valid && report.current === item.id
                ? "in_progress"
                : "pending",
        evidence: completed?.evidence || [],
      };
    }),
  };
}
module.exports = { delegationProgress };

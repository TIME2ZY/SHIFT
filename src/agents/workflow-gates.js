/**
 * Workflow gate facade (Phase D-4).
 *
 * Single import surface for plan approval and outcome-evidence gates.
 * Implementation stays in implementation-plan-gate / outcome-evidence-gate;
 * callers (chat worklist, collab registry, invoke-cli, workflow-evidence,
 * delivery-verifier) should prefer this module over reaching into each file.
 */

const planGate = require("./implementation-plan-gate");
const outcomeGate = require("./outcome-evidence-gate");

module.exports = {
  // Plan approval gate (Grok write permission)
  ...planGate,
  // Outcome evidence gate (review / delivery / final acceptance)
  ...outcomeGate,
};

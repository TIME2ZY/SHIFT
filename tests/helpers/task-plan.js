"use strict";
const contract = {
  goal: "Deliver outputs",
  deliverables: ["output"],
  acceptanceCriteria: ["valid output"],
  subtasks: [
    {
      id: "first",
      title: "First",
      description: "Produce output",
      workflowId: "sample",
      capabilities: ["analysis"],
      dependsOn: [],
      deliverables: ["output"],
      acceptanceCriteria: ["valid output"],
    },
  ],
};
const team = {
  workflowId: "sample",
  bindings: { produce: { providerId: "agent" } },
  members: [{ providerId: "agent", label: "Agent", availabilityStatus: "available" }],
};
const receipt = {
  state: "completed",
  artifacts: [
    { kind: "document", locator: "result.md", summary: "output", contentHash: "a".repeat(64) },
  ],
  acceptance: {
    verdict: "accepted",
    assessedBy: { providerId: "agent", roleId: "produce" },
    evidenceLevel: "agent_reviewed",
    criteria: ["valid output"],
    evidence: { assessedBy: "agent", summary: "checked output" },
  },
};
module.exports = { contract, team, receipt };

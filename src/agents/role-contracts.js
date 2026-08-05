"use strict";

const { HANDOFF_INTENTS } = require("../shared/collab-contracts");

const WORKFLOW_ROLES = Object.freeze({
  LEAD: "lead",
  DISCUSSION_PARTNER: "discussion_partner",
  IMPLEMENTER: "implementer",
  REVIEWER_DELIVERER: "reviewer_deliverer",
});

/**
 * Runtime source of truth for the four-agent workflow.
 *
 * Capabilities name the handoff intents an agent may receive. Work that does
 * not require a handoff (for example Codex converging a discussion or
 * OpenCode committing an approved diff) is documented as a responsibility.
 */
const AGENT_ROLE_CONTRACTS = Object.freeze({
  codex: freezeContract({
    role: WORKFLOW_ROLES.LEAD,
    capabilities: ["discuss", "accept", "recall"],
    phases: ["discuss", "deliver", "recall"],
    responsibilities: [
      "start_guard",
      "discuss",
      "challenge",
      "converge_solution",
      "final_acceptance",
    ],
  }),
  gemini: freezeContract({
    role: WORKFLOW_ROLES.DISCUSSION_PARTNER,
    capabilities: ["discuss", "recall"],
    phases: ["discuss", "recall"],
    responsibilities: ["discuss", "propose_options", "challenge", "cross_validate"],
  }),
  grok: freezeContract({
    role: WORKFLOW_ROLES.IMPLEMENTER,
    capabilities: ["plan", "implement", "fix", "recall"],
    phases: ["implement", "recall"],
    responsibilities: ["concrete_change_plan", "implement", "test", "change_summary"],
  }),
  opencode: freezeContract({
    role: WORKFLOW_ROLES.REVIEWER_DELIVERER,
    capabilities: ["review", "deliver", "recall"],
    phases: ["review", "deliver", "recall"],
    responsibilities: ["code_review", "review_follow_up", "commit", "push", "pull_request"],
  }),
});

const DEFAULT_INTENT_AGENT_ALLOWLIST = Object.freeze(
  Object.fromEntries(
    HANDOFF_INTENTS.map((intent) => [
      intent,
      Object.freeze(
        Object.entries(AGENT_ROLE_CONTRACTS)
          .filter(([, contract]) => contract.capabilities.includes(intent))
          .map(([agentId]) => agentId)
      ),
    ])
  )
);

function freezeContract(contract) {
  return Object.freeze({
    role: String(contract.role),
    capabilities: Object.freeze(contract.capabilities.slice()),
    phases: Object.freeze(contract.phases.slice()),
    responsibilities: Object.freeze(contract.responsibilities.slice()),
  });
}

function getAgentRoleContract(agentId) {
  const id = String(agentId || "")
    .trim()
    .toLowerCase();
  return AGENT_ROLE_CONTRACTS[id] || null;
}

function agentsWithCapability(capability) {
  const name = String(capability || "")
    .trim()
    .toLowerCase();
  const agents = DEFAULT_INTENT_AGENT_ALLOWLIST[name];
  return agents ? agents.slice() : [];
}

function agentCanReceiveIntent(agentId, intent) {
  return agentsWithCapability(intent).includes(
    String(agentId || "")
      .trim()
      .toLowerCase()
  );
}

function agentIdsForRole(role) {
  const normalized = String(role || "").trim();
  return Object.entries(AGENT_ROLE_CONTRACTS)
    .filter(([, contract]) => contract.role === normalized)
    .map(([agentId]) => agentId);
}

module.exports = {
  WORKFLOW_ROLES,
  AGENT_ROLE_CONTRACTS,
  DEFAULT_INTENT_AGENT_ALLOWLIST,
  getAgentRoleContract,
  agentsWithCapability,
  agentCanReceiveIntent,
  agentIdsForRole,
};

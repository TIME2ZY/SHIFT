const assert = require("node:assert/strict");
const test = require("node:test");

const {
  HANDOFF_INTENTS,
  DEFAULT_PHASE_AGENT_ALLOWLIST,
} = require("../../src/shared/collab-contracts");
const { AGENTS } = require("../../src/agents/catalog");
const {
  WORKFLOW_ROLES,
  AGENT_ROLE_CONTRACTS,
  DEFAULT_INTENT_AGENT_ALLOWLIST,
  getAgentRoleContract,
  agentsWithCapability,
  agentCanReceiveIntent,
  agentIdsForRole,
} = require("../../src/agents/role-contracts");

test("every catalog agent has one immutable workflow role contract", () => {
  assert.deepEqual(Object.keys(AGENT_ROLE_CONTRACTS).sort(), Object.keys(AGENTS).sort());

  for (const [agentId, agent] of Object.entries(AGENTS)) {
    const contract = getAgentRoleContract(agentId);
    assert.ok(contract, `missing role contract for ${agentId}`);
    assert.equal(agent.workflowRole, contract.role);
    assert.deepEqual(agent.workflowCapabilities, contract.capabilities);
    assert.deepEqual(agent.workflowResponsibilities, contract.responsibilities);
    assert.equal(Object.isFrozen(contract), true);
    assert.equal(Object.isFrozen(contract.capabilities), true);
  }
});

test("handoff intents map to the intended receiving agents", () => {
  assert.deepEqual(Object.keys(DEFAULT_INTENT_AGENT_ALLOWLIST), HANDOFF_INTENTS);
  assert.deepEqual(agentsWithCapability("discuss"), ["codex", "gemini", "grok", "opencode"]);
  assert.deepEqual(agentsWithCapability("plan"), ["grok"]);
  assert.deepEqual(agentsWithCapability("implement"), ["grok"]);
  assert.deepEqual(agentsWithCapability("fix"), ["grok"]);
  assert.deepEqual(agentsWithCapability("review"), ["opencode"]);
  assert.deepEqual(agentsWithCapability("deliver"), ["opencode"]);
  assert.deepEqual(agentsWithCapability("accept"), ["codex"]);
  assert.deepEqual(agentsWithCapability("recall"), ["codex", "gemini", "grok", "opencode"]);
});

test("C1 does not grant gate-owning intents to the wrong roles", () => {
  assert.equal(agentCanReceiveIntent("gemini", "implement"), false);
  assert.equal(agentCanReceiveIntent("gemini", "plan"), false);
  assert.equal(agentCanReceiveIntent("gemini", "deliver"), false);
  assert.equal(agentCanReceiveIntent("gemini", "accept"), false);
  assert.equal(agentCanReceiveIntent("gemini", "review"), false);
  assert.equal(agentCanReceiveIntent("codex", "review"), false);
  assert.equal(agentCanReceiveIntent("codex", "implement"), false);
  assert.equal(agentCanReceiveIntent("codex", "deliver"), false);
  assert.equal(agentCanReceiveIntent("grok", "deliver"), false);
  assert.equal(agentCanReceiveIntent("grok", "accept"), false);
  assert.equal(agentCanReceiveIntent("grok", "review"), false);
  assert.equal(agentCanReceiveIntent("opencode", "implement"), false);
  assert.equal(agentCanReceiveIntent("opencode", "plan"), false);
  assert.equal(agentCanReceiveIntent("opencode", "accept"), false);
  assert.equal(agentCanReceiveIntent("grok", "discuss"), true);
  assert.equal(agentCanReceiveIntent("opencode", "discuss"), true);
});

test("role and capability helpers normalize ids without granting unknown work", () => {
  assert.deepEqual(agentIdsForRole(WORKFLOW_ROLES.LEAD), ["codex"]);
  assert.deepEqual(agentIdsForRole(WORKFLOW_ROLES.IMPLEMENTER), ["grok"]);
  assert.equal(agentCanReceiveIntent(" Codex ", "ACCEPT"), true);
  assert.equal(agentCanReceiveIntent("opencode", "accept"), false);
  assert.equal(agentCanReceiveIntent("unknown", "review"), false);
  assert.equal(getAgentRoleContract("UNKNOWN"), null);
});

test("role phases stay aligned with the five-phase allowlist", () => {
  for (const [phase, expectedAgents] of Object.entries(DEFAULT_PHASE_AGENT_ALLOWLIST)) {
    const actualAgents = Object.entries(AGENT_ROLE_CONTRACTS)
      .filter(([, contract]) => contract.phases.includes(phase))
      .map(([agentId]) => agentId);
    assert.deepEqual(
      actualAgents.sort(),
      expectedAgents.slice().sort(),
      `role contracts drifted from ${phase} phase allowlist`
    );
  }
});

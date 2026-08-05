const DEFAULT_CONTEXT_TOKENS = 200_000;
const DEFAULT_RESERVE_RATIO = 0.2;
const { getAgentRoleContract } = require("./role-contracts");

function model(providerId, modelId, vendorId, options = {}) {
  return {
    id: modelId,
    providerId,
    vendorId,
    contextTokens: options.contextTokens || DEFAULT_CONTEXT_TOKENS,
    reserveRatio:
      typeof options.reserveRatio === "number" ? options.reserveRatio : DEFAULT_RESERVE_RATIO,
    capacitySource: options.capacitySource || "default",
    reasoning: options.reasoning || { supported: false, levels: [] },
  };
}

/** Only models used by the four active agents. */
const MODEL_PROFILES = [
  model("codex", "gpt-5.6-sol", "openai", {
    contextTokens: 258_000,
    capacitySource: "manual",
    reasoning: { supported: true, levels: ["low", "medium", "high"] },
  }),
  model("opencode", "qwen3.7-plus", "alibaba", {
    contextTokens: 1_000_000,
    capacitySource: "manual",
  }),
  model("grok", "grok-4.5", "xai", {
    contextTokens: 500_000,
    capacitySource: "manual",
    reasoning: { supported: true, levels: ["low", "medium", "high"] },
  }),
  model("antigravity", "gemini-3.5-flash", "google", {
    contextTokens: 1_000_000,
    capacitySource: "manual",
    reasoning: { supported: true, levels: ["low", "medium", "high"] },
  }),
];

const MODELS = Object.fromEntries(
  MODEL_PROFILES.map((profile) => [`${profile.providerId}:${profile.id}`, profile])
);

function agent(id, label, providerId, modelId, description, options = {}) {
  const workflow = getAgentRoleContract(id);
  return {
    id,
    label,
    providerId,
    model: modelId,
    ...(options.capacityTokens ? { capacityTokens: options.capacityTokens } : {}),
    reasoningEffort: options.reasoningEffort || "",
    ...(options.transport ? { transport: options.transport } : {}),
    description,
    workflowRole: workflow?.role || "",
    workflowCapabilities: workflow ? workflow.capabilities.slice() : [],
    workflowResponsibilities: workflow ? workflow.responsibilities.slice() : [],
  };
}

/**
 * Four agents only — id equals the display name (lowercase).
 *   codex     · initial/final guard, discussion convergence
 *   gemini    · discussion, options, challenge and cross-validation
 *   grok      · concrete change plan, implementation and test summary
 *   opencode  · code review and delivery
 */
const AGENTS = {
  codex: agent(
    "codex",
    "Codex",
    "codex",
    "gpt-5.6-sol",
    "开始与末尾把关：参与讨论、与 Gemini 互证并收敛方案，最终按用户目标验收。",
    { reasoningEffort: "medium" }
  ),
  gemini: agent(
    "gemini",
    "Gemini",
    "antigravity",
    "gemini-3.5-flash",
    "讨论伙伴：提出正常可行的选项、风险与反例，与 Codex 互相验证，不为猎奇而发散。",
    { reasoningEffort: "high" }
  ),
  grok: agent("grok", "Grok", "grok", "grok-4.5", "实现：先给具体修改方案，再按批准方案改代码、跑测试并总结。", {
    reasoningEffort: "high",
    transport: "acp",
  }),
  opencode: agent(
    "opencode",
    "OpenCode",
    "opencode",
    "qwen3.7-plus",
    "Review 与交付：代码评审、质量把关；批准后规范 commit、push 和 PR 描述。"
  ),
};

function getModelProfile(providerId, modelId) {
  return MODELS[`${providerId}:${modelId}`] || null;
}

function requireModelProfile(providerId, modelId) {
  const profile = getModelProfile(providerId, modelId);
  if (profile) return profile;
  const supported = MODEL_PROFILES.filter((candidate) => candidate.providerId === providerId).map(
    (candidate) => candidate.id
  );
  throw new Error(
    `Unsupported ${providerId} model "${modelId}". Supported models: ${supported.join(", ")}.`
  );
}

function getAgentModelProfile(agentId) {
  const profile = AGENTS[agentId];
  return profile ? getModelProfile(profile.providerId, profile.model) : null;
}

module.exports = {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_RESERVE_RATIO,
  MODEL_PROFILES,
  MODELS,
  AGENTS,
  getModelProfile,
  requireModelProfile,
  getAgentModelProfile,
};

const DEFAULT_CONTEXT_TOKENS = 200_000;
const DEFAULT_RESERVE_RATIO = 0.2;

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
  return {
    id,
    label,
    providerId,
    model: modelId,
    ...(options.capacityTokens ? { capacityTokens: options.capacityTokens } : {}),
    reasoningEffort: options.reasoningEffort || "",
    ...(options.transport ? { transport: options.transport } : {}),
    description,
  };
}

/**
 * Four agents only — id equals the display name (lowercase).
 *   codex     · reasoning & discussion
 *   gemini    · ideation / brainstorm
 *   grok      · implementation
 *   opencode  · code review
 */
const AGENTS = {
  codex: agent(
    "codex",
    "Codex",
    "codex",
    "gpt-5.6-sol",
    "推理与讨论：澄清问题、权衡方案，可与 Gemini 交叉验证。",
    { reasoningEffort: "medium" }
  ),
  gemini: agent(
    "gemini",
    "Gemini",
    "antigravity",
    "gemini-3.5-flash",
    "想法与头脑风暴：发散灵感，可与 Codex 互证收敛（默认 plan，少改文件）。",
    { reasoningEffort: "high" }
  ),
  grok: agent("grok", "Grok", "grok", "grok-4.5", "实现：写代码、改功能、跑测试。", {
    reasoningEffort: "high",
    transport: "acp",
  }),
  opencode: agent(
    "opencode",
    "OpenCode",
    "opencode",
    "qwen3.7-plus",
    "Review：代码评审、质量与安全把关、放行确认。"
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

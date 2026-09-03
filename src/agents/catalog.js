const DEFAULT_CONTEXT_TOKENS = 200_000;
const DEFAULT_RESERVE_RATIO = 0.2;
/** Fallback when a profile omits native compact metadata (relative to physical window). */
const DEFAULT_NATIVE_COMPACT_RATIO = 0.85;
/** Physical points: SHIFT action = native - margin (when no absolute seal tokens). */
const DEFAULT_SEAL_MARGIN = 0.08;
/** Physical points between soft/warn and action. */
const DEFAULT_SEAL_SOFT_GAP = 0.04;
/** Physical points between recovery and soft (sealer hysteresis). */
const DEFAULT_SEAL_RECOVERY_GAP = 0.05;
const { getAgentRoleContract } = require("./role-contracts");

function model(providerId, modelId, vendorId, options = {}) {
  const profile = {
    id: modelId,
    providerId,
    vendorId,
    contextTokens: options.contextTokens || DEFAULT_CONTEXT_TOKENS,
    reserveRatio:
      typeof options.reserveRatio === "number" ? options.reserveRatio : DEFAULT_RESERVE_RATIO,
    capacitySource: options.capacitySource || "default",
    reasoning: options.reasoning || { supported: false, levels: [] },
  };

  if (typeof options.nativeCompactRatio === "number") {
    profile.nativeCompactRatio = options.nativeCompactRatio;
  }
  if (typeof options.nativeCompactTokens === "number") {
    profile.nativeCompactTokens = options.nativeCompactTokens;
  }
  if (typeof options.sealMargin === "number") {
    profile.sealMargin = options.sealMargin;
  }
  if (typeof options.sealSoftGap === "number") {
    profile.sealSoftGap = options.sealSoftGap;
  }
  if (typeof options.sealRecoveryGap === "number") {
    profile.sealRecoveryGap = options.sealRecoveryGap;
  }
  // Absolute quality/safety caps (e.g. Gemini 300k) — take precedence over ratio math.
  if (typeof options.sealActionTokens === "number") {
    profile.sealActionTokens = options.sealActionTokens;
  }
  if (typeof options.sealSoftTokens === "number") {
    profile.sealSoftTokens = options.sealSoftTokens;
  }
  // Optional explicit usable ratios (override derived soft/action usable).
  if (typeof options.sealSoftUsableRatio === "number") {
    profile.sealSoftUsableRatio = options.sealSoftUsableRatio;
  }
  if (typeof options.sealActionUsableRatio === "number") {
    profile.sealActionUsableRatio = options.sealActionUsableRatio;
  }

  return profile;
}

/**
 * Only models used by the four active agents.
 *
 * nativeCompact* documents provider auto-compact (or quality cap for Gemini).
 * SHIFT seal must land earlier; see resolveSealThresholds in context-budget.js.
 */
const MODEL_PROFILES = [
  model("codex", "gpt-5.6-sol", "openai", {
    contextTokens: 258_400,
    capacitySource: "manual",
    // CLI: model_auto_compact ≈ window × 0.90 when unset / hard-clamped.
    nativeCompactRatio: 0.9,
    // Usable soft/action stay high: 20% reserve already keeps absolute under native.
    sealSoftUsableRatio: 0.95,
    sealActionUsableRatio: 1.0,
    reasoning: { supported: true, levels: ["low", "medium", "high"] },
  }),
  model("opencode", "deepseek-v4-flash", "deepseek", {
    contextTokens: 1_000_000,
    capacitySource: "manual",
    // estimated > limit − max(requested_output, ~20k buffer) ≈ 980k.
    nativeCompactTokens: 980_000,
    sealSoftUsableRatio: 0.93,
    sealActionUsableRatio: 0.98,
    reasoning: { supported: true, levels: ["low", "high", "max"] },
  }),
  model("grok", "grok-4.6", "xai", {
    contextTokens: 500_000,
    capacitySource: "manual",
    // Local config: [session] auto_compact_threshold_percent = 85 (catalog may say 80).
    nativeCompactRatio: 0.85,
    sealSoftUsableRatio: 0.95,
    sealActionUsableRatio: 1.0,
    reasoning: { supported: true, levels: ["low", "medium", "high"] },
  }),
  model("antigravity", "gemini-3.6-flash", "google", {
    contextTokens: 1_000_000,
    capacitySource: "manual",
    // Gemini CLI-style native compact ~50%; SHIFT quality cap is much earlier.
    nativeCompactRatio: 0.5,
    sealSoftTokens: 270_000,
    sealActionTokens: 300_000,
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
    runtimeCapabilities: Object.freeze({
      permissionCallbacks: options.permissionCallbacks === true,
    }),
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
    "gemini-3.6-flash",
    "讨论伙伴：提出正常可行的选项、风险与反例，与 Codex 互相验证，不为猎奇而发散。",
    { reasoningEffort: "high" }
  ),
  grok: agent(
    "grok",
    "Grok",
    "grok",
    "grok-4.6",
    "实现：先给具体修改方案，再按批准方案改代码、跑测试并总结。",
    {
      reasoningEffort: "high",
      transport: "acp",
      permissionCallbacks: true,
    }
  ),
  opencode: agent(
    "opencode",
    "OpenCode",
    "opencode",
    "deepseek-v4-flash",
    "Review 与交付：代码评审、质量把关；批准后规范 commit、push 和 PR 描述。",
    { reasoningEffort: "max" }
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
  DEFAULT_NATIVE_COMPACT_RATIO,
  DEFAULT_SEAL_MARGIN,
  DEFAULT_SEAL_SOFT_GAP,
  DEFAULT_SEAL_RECOVERY_GAP,
  MODEL_PROFILES,
  MODELS,
  AGENTS,
  getModelProfile,
  requireModelProfile,
  getAgentModelProfile,
};

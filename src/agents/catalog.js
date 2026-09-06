const fs = require("node:fs");
const path = require("node:path");

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

const AGENT_BINDING_FIELDS = new Set(["model", "reasoningEffort"]);
const PROVIDER_VENDOR = Object.freeze({
  codex: "openai",
  grok: "xai",
  antigravity: "google",
  opencode: "opencode",
});

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
 * Known model profiles used by the four active agents.
 *
 * This is not a startup whitelist. Unknown model IDs inherit the provider's
 * measured window/seal via resolveModelProfile().
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
  model("antigravity", "gemini-3.8-flash", "google", {
    contextTokens: 1_000_000,
    capacitySource: "manual",
    // Gemini CLI-style native compact ~50%; SHIFT quality cap is much earlier.
    nativeCompactRatio: 0.5,
    sealSoftTokens: 270_000,
    sealActionTokens: 300_000,
    reasoning: { supported: true, levels: ["low", "medium", "high"] },
  }),
  model("antigravity", "gemini-3.6-flash", "google", {
    contextTokens: 1_000_000,
    capacitySource: "manual",
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
  };
}

/** Installed provider/runtime profiles. Duty is bound per invocation elsewhere. */
const DEFAULT_AGENTS = Object.freeze({
  codex: Object.freeze(
    agent(
      "codex",
      "Codex",
      "codex",
      "gpt-5.6-sol",
      "OpenAI Codex CLI runtime。支持代码读取、修改、命令执行与结构化事件输出。",
      { reasoningEffort: "medium" }
    )
  ),
  gemini: Object.freeze(
    agent(
      "gemini",
      "Gemini",
      "antigravity",
      "gemini-3.8-flash",
      "Antigravity CLI runtime，使用 Gemini 模型并输出结构化流事件。",
      { reasoningEffort: "high" }
    )
  ),
  grok: Object.freeze(
    agent(
      "grok",
      "Grok",
      "grok",
      "grok-4.6",
      "Grok ACP runtime。支持平台权限回调与结构化工具事件。",
      {
        reasoningEffort: "high",
        transport: "acp",
        permissionCallbacks: true,
      }
    )
  ),
  opencode: Object.freeze(
    agent(
      "opencode",
      "OpenCode",
      "opencode",
      "deepseek-v4-flash",
      "OpenCode CLI runtime。支持代码工具、推理流与结构化使用量事件。",
      { reasoningEffort: "max" }
    )
  ),
});

const AGENTS = cloneAgents(DEFAULT_AGENTS);

function cloneAgent(source) {
  return {
    ...source,
    runtimeCapabilities: { ...source.runtimeCapabilities },
  };
}

function cloneAgents(source) {
  return Object.fromEntries(
    Object.entries(source).map(([id, profile]) => [id, cloneAgent(profile)])
  );
}

function replaceAgentCatalog(next) {
  for (const key of Object.keys(AGENTS)) {
    delete AGENTS[key];
  }
  Object.assign(AGENTS, next);
}

function getModelProfile(providerId, modelId) {
  return MODELS[`${providerId}:${modelId}`] || null;
}

function fallbackModelProfile(providerId, modelId) {
  const defaultAgent = Object.values(DEFAULT_AGENTS).find(
    (profile) => profile.providerId === providerId
  );
  const base =
    (defaultAgent && getModelProfile(providerId, defaultAgent.model)) ||
    MODEL_PROFILES.find((profile) => profile.providerId === providerId) ||
    null;
  if (base) {
    return {
      ...base,
      id: modelId,
      capacitySource: "fallback",
    };
  }
  return model(providerId, modelId, PROVIDER_VENDOR[providerId] || "unknown", {
    contextTokens: DEFAULT_CONTEXT_TOKENS,
    capacitySource: "fallback",
    nativeCompactRatio: DEFAULT_NATIVE_COMPACT_RATIO,
  });
}

function resolveModelProfile(providerId, modelId) {
  if (!providerId || !modelId) return null;
  return getModelProfile(providerId, modelId) || fallbackModelProfile(providerId, modelId);
}

function getAgentModelProfile(agentId) {
  const profile = AGENTS[agentId];
  return profile ? resolveModelProfile(profile.providerId, profile.model) : null;
}

function loadAgentBindings(filePath) {
  if (!filePath) return {};
  if (!fs.existsSync(filePath)) return {};

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid agent bindings file "${filePath}": ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Agent bindings file "${filePath}" must be a JSON object.`);
  }

  const unknownTop = Object.keys(parsed).filter((key) => key !== "agents");
  if (unknownTop.length) {
    throw new Error(`Unknown agent bindings keys: ${unknownTop.join(", ")}. Allowed: agents.`);
  }

  const agents = parsed.agents;
  if (agents == null) return {};
  if (typeof agents !== "object" || Array.isArray(agents)) {
    throw new Error(`Agent bindings "agents" must be an object.`);
  }
  return agents;
}

function mergeAgentCatalog(bindings = {}) {
  const next = cloneAgents(DEFAULT_AGENTS);
  for (const [id, override] of Object.entries(bindings)) {
    if (!DEFAULT_AGENTS[id]) {
      throw new Error(
        `Unknown agent "${id}" in bindings. Supported: ${Object.keys(DEFAULT_AGENTS).join(", ")}.`
      );
    }
    if (!override || typeof override !== "object" || Array.isArray(override)) {
      throw new Error(`Agent binding for "${id}" must be an object.`);
    }
    const unknown = Object.keys(override).filter((key) => !AGENT_BINDING_FIELDS.has(key));
    if (unknown.length) {
      throw new Error(
        `Unknown binding fields for "${id}": ${unknown.join(", ")}. Allowed: ${[
          ...AGENT_BINDING_FIELDS,
        ].join(", ")}.`
      );
    }
    if (override.model !== undefined) {
      const modelId = String(override.model || "").trim();
      if (!modelId) {
        throw new Error(`Agent binding "${id}.model" must be a non-empty string.`);
      }
      next[id].model = modelId;
    }
    if (override.reasoningEffort !== undefined) {
      const effort = String(override.reasoningEffort || "").trim();
      if (!effort) {
        throw new Error(`Agent binding "${id}.reasoningEffort" must be a non-empty string.`);
      }
      next[id].reasoningEffort = effort;
    }
  }
  return next;
}

function applyAgentBindings(bindings = {}) {
  replaceAgentCatalog(mergeAgentCatalog(bindings));
  return AGENTS;
}

function resetAgentCatalog() {
  replaceAgentCatalog(cloneAgents(DEFAULT_AGENTS));
  return AGENTS;
}

function loadAgentCatalogFromHome(shiftHome) {
  const filePath = path.join(String(shiftHome || ""), "agents.json");
  applyAgentBindings(loadAgentBindings(filePath));
  return AGENTS;
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
  DEFAULT_AGENTS,
  AGENTS,
  getModelProfile,
  resolveModelProfile,
  getAgentModelProfile,
  loadAgentBindings,
  mergeAgentCatalog,
  applyAgentBindings,
  resetAgentCatalog,
  loadAgentCatalogFromHome,
};

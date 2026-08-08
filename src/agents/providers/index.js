const { codexProvider } = require("./codex");
const { opencodeProvider } = require("./opencode");
const { grokProvider } = require("./grok");
const { grokAcpAdapter } = require("./grok-acp");
const { antigravityProvider } = require("./antigravity");
const { requireModelProfile } = require("../catalog");
const {
  assertCanonicalEvent,
  makeEvent,
  normalizeCanonicalEvent,
  createRunLifecycle,
} = require("../event-protocol");
const { resolveProxy, proxyEnvVars } = require("../proxy");
const { createUsageAccumulator } = require("../usage");
const { windowsUtf8Environment } = require("../windows-runtime");
const { limitCanonicalEvent } = require("../event-size-policy");

const REQUIRED_ADAPTER_METHODS = ["createRuntime", "buildInvocation"];

grokProvider.acp = grokAcpAdapter;

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ""));
}

function assertProviderAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("Provider adapter must be an object.");
  }
  if (!adapter.id || typeof adapter.id !== "string") {
    throw new Error("Provider adapter id is required.");
  }
  for (const method of REQUIRED_ADAPTER_METHODS) {
    if (typeof adapter[method] !== "function") {
      throw new Error(`Provider adapter "${adapter.id}" must implement ${method}().`);
    }
  }
  if (!adapter.capabilities || typeof adapter.capabilities !== "object") {
    throw new Error(`Provider adapter "${adapter.id}" must declare capabilities.`);
  }
  if (!Array.isArray(adapter.allowedProviderOptions)) {
    throw new Error(
      `Provider adapter "${adapter.id}" must declare allowedProviderOptions as an array.`
    );
  }
  if (adapter.classifyStderr !== undefined && typeof adapter.classifyStderr !== "function") {
    throw new Error(`Provider adapter "${adapter.id}" classifyStderr must be a function.`);
  }
  return adapter;
}

const PROVIDERS = Object.fromEntries(
  [codexProvider, opencodeProvider, grokProvider, antigravityProvider].map((adapter) => {
    assertProviderAdapter(adapter);
    return [adapter.id, adapter];
  })
);
const PROVIDER_RUNTIMES = Object.fromEntries(
  Object.entries(PROVIDERS).map(([id, adapter]) => [id, adapter.createRuntime])
);

function getProviderAdapter(providerId) {
  const adapter = PROVIDERS[providerId];
  if (!adapter) {
    throw new Error(
      `Unsupported provider "${providerId}". Supported: ${Object.keys(PROVIDERS).join(", ")}`
    );
  }
  return adapter;
}

function validateProviderOptions(adapter, providerOptions) {
  if (providerOptions == null) return {};
  if (typeof providerOptions !== "object" || Array.isArray(providerOptions)) {
    throw new Error(
      `providerOptions for "${adapter.id}" must be a plain object (got ${
        Array.isArray(providerOptions) ? "array" : typeof providerOptions
      }).`
    );
  }
  const options = providerOptions;
  const allowed = new Set(adapter.allowedProviderOptions || []);
  const unknown = Object.keys(options).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new Error(
      `Unknown providerOptions for "${adapter.id}": ${unknown.join(", ")}. Allowed: ${
        [...allowed].join(", ") || "(none)"
      }.`
    );
  }
  return options;
}

function validateProviderConfig(config) {
  const providerId = config && config.providerId;
  const adapter = getProviderAdapter(providerId);
  const modelProfile = config.model ? requireModelProfile(providerId, config.model) : null;

  validateProviderOptions(adapter, config.providerOptions);

  if (config.reasoningEffort && modelProfile && modelProfile.reasoning.supported) {
    const levels = modelProfile.reasoning.levels || [];
    if (levels.length && !levels.includes(config.reasoningEffort)) {
      throw new Error(
        `Unsupported reasoning effort "${config.reasoningEffort}" for ${providerId}/${config.model}. Supported: ${levels.join(", ")}.`
      );
    }
  }
  if (typeof adapter.validate === "function") adapter.validate(config, modelProfile);
  return { adapter, modelProfile };
}

/**
 * Create a provider runtime envelope.
 *
 * @param {object} config provider/agent config
 * @param {{ lifecycle?: ReturnType<typeof createRunLifecycle> }} [options]
 *   Pass a shared lifecycle from the process supervisor so retries keep one
 *   invocation lifecycle while decoder state is recreated per attempt.
 */
function createProviderRuntime(config, options = {}) {
  const { adapter } = validateProviderConfig(config);
  const transportAdapter = options.transport === "acp" && adapter.acp ? adapter.acp : adapter;
  const runtime = transportAdapter.createRuntime(config);
  if (!runtime || typeof runtime.transform !== "function") {
    throw new Error(`Provider runtime "${adapter.id}" must implement transform().`);
  }
  const lifecycle = options.lifecycle || createRunLifecycle();
  const usageAccumulator = options.usageAccumulator || createUsageAccumulator();

  const validateEvents = (events, context, sessionId = "") => {
    if (!Array.isArray(events)) {
      throw new Error(`Provider runtime "${adapter.id}" must return an event array.`);
    }
    if (lifecycle.terminal) return [];

    let normalized = events.map(normalizeCanonicalEvent).map(limitCanonicalEvent);
    const needsStart =
      normalized.length > 0 &&
      !lifecycle.started &&
      !normalized.some((event) => event.type === "run.started");
    if (needsStart) {
      normalized = [
        makeEvent("run.started", {
          agent: context.agent,
          invocationId: context.invocationId,
          sessionId,
          provider: adapter.id,
          model: config.model || "",
        }),
        ...normalized,
      ];
    }

    const accepted = [];
    for (const event of normalized) {
      const acceptedUsage = usageAccumulator.accept(event);
      if (!acceptedUsage) continue;
      if (!lifecycle.accept(acceptedUsage.type)) continue;
      accepted.push(assertCanonicalEvent(acceptedUsage));
    }
    return accepted;
  };
  return {
    get started() {
      return lifecycle.started;
    },
    get terminal() {
      return lifecycle.terminal;
    },
    extractSessionId:
      typeof runtime.extractSessionId === "function"
        ? runtime.extractSessionId.bind(runtime)
        : () => "",
    parseStdoutLine:
      typeof runtime.parseStdoutLine === "function"
        ? runtime.parseStdoutLine.bind(runtime)
        : undefined,
    classifyStderr:
      typeof adapter.classifyStderr === "function"
        ? adapter.classifyStderr.bind(adapter)
        : undefined,
    acceptDiagnostics(events, context) {
      return validateEvents(events, context);
    },
    transform(event, context) {
      if (lifecycle.terminal) return [];
      const sessionId =
        typeof runtime.extractSessionId === "function" ? runtime.extractSessionId(event) : "";
      return validateEvents(runtime.transform(event, context), context, sessionId);
    },
    finish(context, outcome = {}) {
      if (lifecycle.terminal && outcome.terminal !== true) return [];
      const rawEvents =
        lifecycle.terminal || typeof runtime.finish !== "function"
          ? []
          : runtime.finish(context, outcome);
      const events = validateEvents(rawEvents, context);
      if (outcome.terminal === true && !lifecycle.terminal) {
        if (!lifecycle.started) {
          const started = assertCanonicalEvent(
            makeEvent("run.started", {
              agent: context.agent,
              invocationId: context.invocationId,
              sessionId: "",
              provider: adapter.id,
              model: config.model || "",
            })
          );
          if (lifecycle.accept(started.type)) events.push(started);
        }
        const terminalEvent = outcome.ok
          ? makeEvent("run.finished", {
              agent: context.agent,
              invocationId: context.invocationId,
              exitCode: outcome.exitCode ?? 0,
              signal: outcome.signal || null,
            })
          : makeEvent("run.failed", {
              agent: context.agent,
              invocationId: context.invocationId,
              error: outcome.error || "Provider process failed.",
              exitCode: outcome.exitCode ?? null,
              signal: outcome.signal || null,
            });
        const terminal = assertCanonicalEvent(terminalEvent);
        if (lifecycle.accept(terminal.type)) events.push(terminal);
      }
      return events;
    },
  };
}

/**
 * Collect startup diagnostics across all registered adapters (no provider hardcoding).
 */
function collectProviderStartupDiagnostics(env = process.env) {
  if (!isTruthyEnv(env.INVOKE_CLI_PROXY_LOG)) return [];

  const messages = [];
  const globalProxy = resolveProxy({}, env);
  if (globalProxy) {
    messages.push(`CLI proxy: ${globalProxy} (INVOKE_CLI_PROXY / HTTPS_PROXY / HTTP_PROXY)`);
  }

  for (const adapter of Object.values(PROVIDERS)) {
    const options = { proxy: "", providerOptions: {} };
    const proxy =
      typeof adapter.resolveProxy === "function"
        ? adapter.resolveProxy(options, env)
        : resolveProxy(options, env);
    if (proxy && proxy !== globalProxy) {
      messages.push(`${adapter.id} proxy: ${proxy}`);
    }
    if (typeof adapter.diagnostics === "function") {
      const extra = adapter.diagnostics({ ...options, proxy }, env);
      if (Array.isArray(extra)) {
        for (const line of extra) {
          if (typeof line === "string" && line.trim()) messages.push(line);
        }
      }
    }
  }

  if (!globalProxy && messages.length === 0) {
    messages.push("CLI proxy: (none)");
  }
  return messages;
}

function buildProviderInvocation(config, prompt, context = {}) {
  const { adapter } = validateProviderConfig(config);
  return adapter.buildInvocation(config, prompt, context);
}

function getProviderTransportAdapter(config, transport = config?.transport || "cli") {
  const { adapter } = validateProviderConfig(config);
  if (transport === "cli") return adapter;
  if (transport === "acp" && adapter.acp) return adapter.acp;
  throw new Error(`Provider "${adapter.id}" does not support transport "${transport}".`);
}

function buildProviderTransportInvocation(
  config,
  prompt,
  transport = config?.transport || "cli",
  context = {}
) {
  const adapter = getProviderTransportAdapter(config, transport);
  return adapter.buildInvocation(config, prompt, context);
}

function resolveProviderRunOptions(config, options = {}, env = process.env) {
  const { adapter } = validateProviderConfig(config);
  const proxy =
    typeof adapter.resolveProxy === "function"
      ? adapter.resolveProxy(options, env)
      : resolveProxy(options, env);
  return { ...options, proxy };
}

/**
 * Build the env patch for a provider CLI child process.
 * Always injects shared proxy vars; adapters may add provider-owned keys.
 */
function buildProviderEnvironment(config, options = {}, env = process.env) {
  const { adapter } = validateProviderConfig(config);
  const runOptions = resolveProviderRunOptions(config, options, env);
  const patch = {
    ...windowsUtf8Environment(env),
    ...proxyEnvVars(runOptions.proxy),
  };
  if (typeof adapter.buildEnvironment === "function") {
    Object.assign(patch, adapter.buildEnvironment(runOptions, env) || {});
  }
  return { env: { ...env, ...patch }, proxy: runOptions.proxy, runOptions };
}

/**
 * Collect diagnostic messages for stderr before spawn.
 * Shared proxy log + adapter-owned warnings (e.g. missing Grok proxy).
 */
function getProviderDiagnostics(config, options = {}, env = process.env) {
  const { adapter } = validateProviderConfig(config);
  const runOptions = resolveProviderRunOptions(config, options, env);
  const messages = [];

  if (runOptions.proxy && isTruthyEnv(env.INVOKE_CLI_PROXY_LOG)) {
    messages.push(`[invoke-cli] proxy for ${adapter.id}: ${runOptions.proxy}`);
  }

  if (typeof adapter.diagnostics === "function") {
    const extra = adapter.diagnostics(runOptions, env);
    if (Array.isArray(extra)) {
      for (const line of extra) {
        if (typeof line === "string" && line.trim()) messages.push(line);
      }
    }
  }

  return messages;
}

function listSupportedProviders() {
  return Object.keys(PROVIDERS);
}

module.exports = {
  PROVIDERS,
  // Compatibility alias for existing integrations.
  PROVIDER_RUNTIMES,
  assertProviderAdapter,
  getProviderAdapter,
  validateProviderConfig,
  validateProviderOptions,
  createProviderRuntime,
  buildProviderInvocation,
  buildProviderTransportInvocation,
  getProviderTransportAdapter,
  resolveProviderRunOptions,
  buildProviderEnvironment,
  getProviderDiagnostics,
  collectProviderStartupDiagnostics,
  listSupportedProviders,
};

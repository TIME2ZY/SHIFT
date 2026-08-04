const { AGENTS } = require("./catalog");
const {
  createProviderRuntime,
  buildProviderInvocation,
  buildProviderTransportInvocation,
  buildProviderEnvironment,
  getProviderDiagnostics,
} = require("./providers");
const { normalizeRunOptions } = require("./run-options");
const { resolveProxy, resolveProviderProxy, proxyEnvVars } = require("./proxy");
const { persistSessionId } = require("./session-persistence");
const { createRawEventLogger } = require("./raw-event-logger");
const {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_KILL_GRACE_MS,
  superviseProviderProcess,
} = require("./process-supervisor");
const { ENV } = require("../shared/brand");
const { ROOT } = require("../shared/runtime-paths");
const { loadProjectEnv } = require("../shared/load-env");
const { invokeAcp } = require("./invoke-acp");

function parseArgs(argv) {
  const args = [...argv];
  let agentName = "codex";
  const options = {
    // Provider adapters resolve environment-specific proxy fallbacks.
    proxy: "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    killGraceMs: DEFAULT_KILL_GRACE_MS,
    retries: 0,
  };

  while (args.length > 0) {
    const arg = args[0];

    if (arg === "--") {
      args.shift();
      break;
    }

    if (arg === "--agent") {
      agentName = args[1];
      args.splice(0, 2);
      continue;
    }

    if (arg.startsWith("--agent=")) {
      agentName = arg.slice("--agent=".length);
      args.shift();
      continue;
    }

    if (arg === "--proxy") {
      options.proxy = args[1];
      args.splice(0, 2);
      continue;
    }

    if (arg.startsWith("--proxy=")) {
      options.proxy = arg.slice("--proxy=".length);
      args.shift();
      continue;
    }

    if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInteger(args[1], "--timeout-ms");
      args.splice(0, 2);
      continue;
    }

    if (arg.startsWith("--timeout-ms=")) {
      options.timeoutMs = parsePositiveInteger(arg.slice("--timeout-ms=".length), "--timeout-ms");
      args.shift();
      continue;
    }

    if (arg === "--kill-grace-ms") {
      options.killGraceMs = parsePositiveInteger(args[1], "--kill-grace-ms");
      args.splice(0, 2);
      continue;
    }

    if (arg.startsWith("--kill-grace-ms=")) {
      options.killGraceMs = parsePositiveInteger(
        arg.slice("--kill-grace-ms=".length),
        "--kill-grace-ms"
      );
      args.shift();
      continue;
    }

    if (arg === "--retries") {
      options.retries = parseNonNegativeInteger(args[1], "--retries");
      args.splice(0, 2);
      continue;
    }

    if (arg.startsWith("--retries=")) {
      options.retries = parseNonNegativeInteger(arg.slice("--retries=".length), "--retries");
      args.shift();
      continue;
    }

    break;
  }

  const agent = AGENTS[agentName];
  if (!agent) {
    throw new Error(
      `Unsupported agent "${agentName}". Use one of: ${Object.keys(AGENTS).join(", ")}.`
    );
  }

  return {
    cli: {
      ...agent,
    },
    options,
    prompt: args.join(" "),
  };
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function parseNonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }

  return parsed;
}

function buildInvocation(cli, prompt) {
  const config = typeof cli === "string" ? { providerId: cli } : cli;
  return buildProviderInvocation(config, prompt);
}

function invoke(cli, prompt, options = {}) {
  const baseConfig = typeof cli === "string" ? { providerId: cli } : cli;
  const runOptions = normalizeRunOptions(options, {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    killGraceMs: DEFAULT_KILL_GRACE_MS,
    retries: 0,
  });
  const config = {
    ...baseConfig,
    providerOptions: {
      ...(baseConfig.providerOptions || {}),
      ...runOptions.providerOptions,
    },
  };
  const providerId = config.providerId;
  // Read session ID from env (set by server). If present, resume the previous
  // CLI session; if absent, cold start.
  const resumeSessionId = process.env.INVOKE_SESSION_ID || "";
  const resolvedCli = resumeSessionId ? { ...config, resumeSessionId } : config;
  const transport = resolvedCli.transport || "cli";
  const workspaceCwd = process.env[ENV.WORKTREE_DIR] || process.cwd();
  const { command, args } = buildProviderTransportInvocation(resolvedCli, prompt, transport);
  const { env: childEnv, runOptions: resolvedRun } = buildProviderEnvironment(
    config,
    runOptions,
    process.env
  );

  const invocationId = process.env[ENV.INVOCATION_ID] || "standalone";
  const rawLogger = createRawEventLogger({
    invocationId,
    providerId,
    env: process.env,
  });

  for (const line of getProviderDiagnostics(config, runOptions, process.env)) {
    console.error(line);
  }

  if (transport === "acp") {
    return invokeAcp({
      config: { ...resolvedCli, prompt },
      command,
      args,
      env: childEnv,
      cwd: workspaceCwd,
      eventContext: {
        agent: config.id || providerId,
        invocationId,
      },
      onEvent: (event) => {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      },
      onRawEvent: (raw) => rawLogger.log(raw),
      onSessionId: (sessionId) => persistSessionId(config, sessionId),
      timeoutMs: resolvedRun.timeoutMs,
      killGraceMs: resolvedRun.killGraceMs,
    });
  }

  return superviseProviderProcess({
    command,
    args,
    cwd: workspaceCwd,
    env: childEnv,
    timeoutMs: resolvedRun.timeoutMs,
    killGraceMs: resolvedRun.killGraceMs,
    retries: resolvedRun.retries ?? 0,
    // Shared lifecycle across retries; decoder state recreated per attempt.
    createRuntime: (lifecycle, shared) =>
      createProviderRuntime(config, {
        lifecycle,
        usageAccumulator: shared && shared.usageAccumulator,
      }),
    eventContext: {
      agent: config.id || providerId,
      invocationId,
    },
    onEvent: (event) => {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    },
    onRawEvent: (raw) => rawLogger.log(raw),
    onSessionId: (sessionId) => persistSessionId(config, sessionId),
  });
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  if (!parsed.prompt) {
    console.error(
      'Usage: node src/agents/invoke-cli.js [--agent codex|gemini|grok|opencode] [--timeout-ms ms] "你好，请用一句话介绍自己"'
    );
    process.exit(1);
  }

  try {
    await invoke(parsed.cli, parsed.prompt, parsed.options);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  // Standalone CLI: pick up project .env (proxy, CODEX_HOME, …).
  // When spawned by the server, process.env is already populated; load is a no-op for set keys.
  loadProjectEnv(ROOT);
  main();
}

module.exports = {
  AGENTS,
  invoke,
  parseArgs,
  buildInvocation,
  resolveProxy,
  resolveProviderProxy,
  proxyEnvVars,
};

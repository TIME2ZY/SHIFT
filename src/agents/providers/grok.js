const fs = require("node:fs");
const path = require("node:path");
const { firstNonEmpty, resolveProxy } = require("../proxy");
const { createAcpRuntime } = require("../acp-runtime");
const { createAcpShiftContextServer } = require("../shift-context-mcp-config");

/**
 * Grok Build provider — ACP only.
 *
 *   grok agent --no-leader -m grok-4.6 --reasoning-effort high --always-approve stdio
 *
 * Resume is session/load in invoke-acp, not a CLI `-r` flag. Nested subagents are
 * ACP tools; they do not replace SHIFT Seat routing.
 */

const SUPPORTED_GROK_EFFORTS = new Set(["low", "medium", "high"]);

function resolveGrokCommand() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const candidates = [];
  if (home) {
    candidates.push(
      path.join(home, ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok")
    );
  }
  for (const entry of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(entry, process.platform === "win32" ? "grok.exe" : "grok"));
  }
  for (const command of candidates) {
    try {
      if (fs.existsSync(command)) return command;
    } catch {
      // Ignore inaccessible PATH entries.
    }
  }
  return process.platform === "win32" ? "grok.exe" : "grok";
}

function buildGrokAcpInvocation(config) {
  const effort = config.reasoningEffort || "high";
  if (!SUPPORTED_GROK_EFFORTS.has(effort)) {
    throw new Error(`Unsupported Grok ACP reasoning effort "${effort}".`);
  }
  const providerOptions = config.providerOptions || {};
  const args = ["agent", "--no-leader"];
  if (config.model) args.push("-m", config.model);
  if (effort) args.push("--reasoning-effort", effort);
  if (providerOptions.alwaysApprove !== false) args.push("--always-approve");
  args.push("stdio");
  return { command: resolveGrokCommand(), args };
}

const grokProvider = {
  id: "grok",
  protocol: "acp",
  capabilities: {
    resume: true,
    thinking: true,
    tools: true,
    usage: true,
    reasoning: "levels",
  },
  allowedProviderOptions: ["alwaysApprove", "proxy"],
  createRuntime: createAcpRuntime,
  buildMcpServers(_config, env) {
    return [createAcpShiftContextServer(env)];
  },
  resolveProxy(options = {}, env = process.env) {
    const providerOptions = options.providerOptions || {};
    return firstNonEmpty(
      options.proxy,
      providerOptions.proxy,
      env.GROK_PROXY,
      env.INVOKE_GROK_PROXY,
      env.GROK_HTTP_PROXY,
      env.GROK_HTTPS_PROXY,
      resolveProxy({}, env)
    );
  },
  /**
   * Keep Grok-only proxy vars visible to nested tools even when the shared
   * HTTP(S)_PROXY injection comes from GROK_PROXY resolution.
   */
  buildEnvironment(_options = {}, env = process.env) {
    const patch = {};
    if (process.platform === "win32" && !env.HOME && env.USERPROFILE) {
      patch.HOME = env.USERPROFILE;
    }
    for (const key of ["GROK_PROXY", "INVOKE_GROK_PROXY", "GROK_HTTP_PROXY", "GROK_HTTPS_PROXY"]) {
      if (typeof env[key] === "string" && env[key].trim()) {
        patch[key] = env[key].trim();
      }
    }
    return patch;
  },
  diagnostics(options = {}) {
    if (options.proxy) return [];
    return [
      "[invoke-cli] no proxy for grok; if requests hang, set INVOKE_CLI_PROXY=http://127.0.0.1:7892 (all CLIs) or GROK_PROXY (Grok-only)",
    ];
  },
  validate(config) {
    const effort = config.reasoningEffort || "high";
    if (!SUPPORTED_GROK_EFFORTS.has(effort)) {
      throw new Error(
        `Unsupported Grok reasoning effort "${effort}". Supported: ${[
          ...SUPPORTED_GROK_EFFORTS,
        ].join(", ")}.`
      );
    }
  },
  buildInvocation: buildGrokAcpInvocation,
};

module.exports = {
  SUPPORTED_GROK_EFFORTS,
  resolveGrokCommand,
  grokProvider,
};

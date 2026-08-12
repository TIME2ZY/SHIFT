const { createAcpRuntime } = require("../acp-runtime");
const { resolveGrokCommand, SUPPORTED_GROK_EFFORTS } = require("./grok");
const { createAcpShiftContextServer } = require("../shift-context-mcp-config");

const grokAcpAdapter = {
  id: "grok-acp",
  protocol: "acp",
  capabilities: {
    resume: true,
    thinking: true,
    tools: true,
    usage: true,
    reasoning: "levels",
  },
  createRuntime: createAcpRuntime,
  buildMcpServers(_config, env) {
    return [createAcpShiftContextServer(env)];
  },
  buildInvocation(config) {
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
  },
};

module.exports = {
  grokAcpAdapter,
};

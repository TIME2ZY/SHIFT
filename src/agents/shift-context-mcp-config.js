const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SHIFT_CONTEXT_SERVER_NAME = "shift_context";
const SHIFT_CONTEXT_TOOLS = Object.freeze([
  "memory_write",
  "memory_evidence_list",
  "recall_search",
]);
const SHIFT_CONTEXT_ENV_KEYS = Object.freeze([
  "SHIFT_API_URL",
  "SHIFT_THREAD_ID",
  "SHIFT_INVOCATION_ID",
  "SHIFT_CALLBACK_TOKEN",
]);

function shiftContextServerScript() {
  return path.resolve(__dirname, "../../scripts/shift-context-mcp.js");
}

function createShiftContextStdioDescriptor() {
  return {
    name: SHIFT_CONTEXT_SERVER_NAME,
    command: process.execPath,
    args: [shiftContextServerScript()],
    envKeys: [...SHIFT_CONTEXT_ENV_KEYS],
    tools: [...SHIFT_CONTEXT_TOOLS],
  };
}

function createCodexShiftContextArgs() {
  const descriptor = createShiftContextStdioDescriptor();
  return [
    "-c",
    `mcp_servers.${descriptor.name}.command=${JSON.stringify(descriptor.command)}`,
    "-c",
    `mcp_servers.${descriptor.name}.args=[${descriptor.args.map(JSON.stringify).join(",")}]`,
    "-c",
    `mcp_servers.${descriptor.name}.env_vars=${JSON.stringify(descriptor.envKeys)}`,
    "-c",
    `mcp_servers.${descriptor.name}.enabled_tools=${JSON.stringify(descriptor.tools)}`,
    "-c",
    `mcp_servers.${descriptor.name}.default_tools_approval_mode="auto"`,
    "-c",
    `mcp_servers.${descriptor.name}.required=false`,
  ];
}

function createOpencodeShiftContextConfig(existingContent = "") {
  let config = {};
  if (String(existingContent || "").trim()) {
    try {
      config = JSON.parse(existingContent);
    } catch (error) {
      throw new Error(`OPENCODE_CONFIG_CONTENT must be valid JSON: ${error.message}`);
    }
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("OPENCODE_CONFIG_CONTENT must contain a JSON object.");
  }
  const descriptor = createShiftContextStdioDescriptor();
  return JSON.stringify({
    ...config,
    mcp: {
      ...(config.mcp || {}),
      [descriptor.name]: {
        type: "local",
        command: [descriptor.command, ...descriptor.args],
        enabled: true,
      },
    },
  });
}

function createAcpShiftContextServer(env = process.env) {
  const descriptor = createShiftContextStdioDescriptor();
  return {
    name: descriptor.name,
    command: descriptor.command,
    args: descriptor.args,
    env: descriptor.envKeys.map((name) => ({ name, value: String(env[name] || "") })),
  };
}

function antigravityMcpConfigPath(env = process.env) {
  const driveHome = env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : "";
  const home = String(env.USERPROFILE || driveHome || os.homedir());
  return path.join(home, ".gemini", "config", "mcp_config.json");
}

function isOwnedShiftContextConfig(value) {
  return Boolean(
    value &&
      Array.isArray(value.args) &&
      value.args.some((arg) => path.basename(String(arg)) === "shift-context-mcp.js")
  );
}

function ensureAntigravityShiftContextConfig(env = process.env) {
  const file = antigravityMcpConfigPath(env);
  let config = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, "utf8").trim();
    if (raw) {
      try {
        config = JSON.parse(raw);
      } catch (error) {
        throw new Error(`Cannot register Shift MCP in invalid ${file}: ${error.message}`);
      }
    }
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Cannot register Shift MCP because ${file} is not a JSON object.`);
  }
  const servers =
    config.mcpServers && typeof config.mcpServers === "object"
      ? { ...config.mcpServers }
      : {};
  const existing = servers[SHIFT_CONTEXT_SERVER_NAME];
  if (existing && !isOwnedShiftContextConfig(existing)) {
    throw new Error(
      `Antigravity MCP name "${SHIFT_CONTEXT_SERVER_NAME}" is already owned by another server.`
    );
  }
  const descriptor = createShiftContextStdioDescriptor();
  const nextServer = { command: descriptor.command, args: descriptor.args };
  if (existing && JSON.stringify(existing) === JSON.stringify(nextServer)) return file;

  servers[SHIFT_CONTEXT_SERVER_NAME] = nextServer;
  const next = { ...config, mcpServers: servers };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
  return file;
}

module.exports = {
  SHIFT_CONTEXT_SERVER_NAME,
  SHIFT_CONTEXT_TOOLS,
  SHIFT_CONTEXT_ENV_KEYS,
  shiftContextServerScript,
  createShiftContextStdioDescriptor,
  createCodexShiftContextArgs,
  createOpencodeShiftContextConfig,
  createAcpShiftContextServer,
  antigravityMcpConfigPath,
  ensureAntigravityShiftContextConfig,
};

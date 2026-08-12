#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const COMMANDS = new Set([
  "post-message",
  "thread-context",
  "list-invocations",
  "read-invocation",
]);

function parseArgs(argv) {
  const [command = "", ...rest] = argv;
  if (!COMMANDS.has(command)) {
    throw new Error(`Unknown callback command: ${command || "(missing)"}`);
  }

  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const separator = arg.indexOf("=");
    if (separator !== -1) {
      options[arg.slice(2, separator)] = arg.slice(separator + 1);
      continue;
    }
    const key = arg.slice(2);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function requireEnvironment(env) {
  const apiUrl = String(env.SHIFT_API_URL || "").replace(/\/+$/, "");
  const sessionId = String(env.SHIFT_THREAD_ID || "");
  const invocationId = String(env.SHIFT_INVOCATION_ID || "");
  const callbackToken = String(env.SHIFT_CALLBACK_TOKEN || "");
  const missing = [];
  if (!apiUrl) missing.push("SHIFT_API_URL");
  if (!sessionId) missing.push("SHIFT_THREAD_ID");
  if (!invocationId) missing.push("SHIFT_INVOCATION_ID");
  if (!callbackToken) missing.push("SHIFT_CALLBACK_TOKEN");
  if (missing.length) throw new Error(`Missing callback environment: ${missing.join(", ")}`);
  return { apiUrl, sessionId, invocationId, callbackToken };
}

function readMessageContent(options, cwd, command = "post-message") {
  if (typeof options.content === "string") return options.content;
  if (typeof options["content-file"] === "string") {
    return fs.readFileSync(path.resolve(cwd, options["content-file"]), "utf8");
  }
  throw new Error(`${command} requires --content or --content-file`);
}

function addOptionalSearchParams(params, options, mappings) {
  for (const [optionName, parameterName] of mappings) {
    const value = options[optionName];
    if (value !== undefined && value !== "") params.set(parameterName, value);
  }
}

function buildRequest(command, options, env, cwd = process.cwd()) {
  const context = requireEnvironment(env);
  const url = new URL(`/api/callbacks/${command}`, `${context.apiUrl}/`);
  const headers = {
    Accept: "application/json",
    "X-Callback-Token": context.callbackToken,
  };

  if (command === "post-message") {
    headers["Content-Type"] = "application/json; charset=utf-8";
    return {
      url,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify({
          sessionId: context.sessionId,
          invocationId: context.invocationId,
          callbackToken: context.callbackToken,
          content: readMessageContent(options, cwd, "post-message"),
        }),
      },
    };
  }

  url.searchParams.set("sessionId", context.sessionId);
  url.searchParams.set("invocationId", context.invocationId);
  if (command === "read-invocation") {
    if (!options.target) throw new Error("read-invocation requires --target");
    url.searchParams.set("targetInvocationId", options.target);
    addOptionalSearchParams(url.searchParams, options, [
      ["from", "from"],
      ["limit", "limit"],
    ]);
  }
  return { url, init: { method: "GET", headers } };
}

async function execute(command, options, env, fetchImpl = globalThis.fetch, cwd = process.cwd()) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Global fetch is unavailable; Node 20+ is required");
  }
  const { url, init } = buildRequest(command, options, env, cwd);
  const response = await fetchImpl(url, init);
  const text = await response.text();
  let value;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    value = { raw: text };
  }
  if (!response.ok) {
    const detail = value && (value.error || value.message);
    const suffix = detail ? `: ${detail}` : "";
    throw new Error(`Callback ${command} failed with HTTP ${response.status}${suffix}`);
  }
  return value;
}

function exitCodeForResult(command, result) {
  if (command !== "post-message") return 0;
  if (result?.handoff?.repairRequired) return 2;
  if (result?.handoff?.detected && !result?.handoff?.accepted) return 3;
  return 0;
}

async function main() {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));
    const result = await execute(command, options, process.env);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = exitCodeForResult(command, result);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  COMMANDS,
  parseArgs,
  requireEnvironment,
  readMessageContent,
  buildRequest,
  execute,
  exitCodeForResult,
};

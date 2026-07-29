#!/usr/bin/env node

const readline = require("node:readline");

const SERVER_NAME = "shift-context";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2025-06-18";

const MEMORY_WRITE_TOOL = Object.freeze({
  name: "memory_write",
  description:
    "Store one durable, grounded, atomic conclusion that will affect future work.",
  inputSchema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["decision", "constraint", "fact"],
      },
      topic: {
        type: "string",
        pattern: "^[a-z0-9]+(?:[.-][a-z0-9]+)*$",
        minLength: 3,
        maxLength: 80,
      },
      content: {
        type: "string",
        minLength: 10,
        maxLength: 500,
      },
      scope: {
        type: "string",
        enum: ["thread", "project"],
      },
      evidenceEventNo: {
        type: "integer",
        minimum: 0,
      },
    },
    required: ["kind", "topic", "content", "scope"],
    additionalProperties: false,
  },
  annotations: {
    title: "Write Shift memory",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
});

const MEMORY_EVIDENCE_LIST_TOOL = Object.freeze({
  name: "memory_evidence_list",
  description:
    "List successful tool-result events from the current invocation that may ground a fact memory.",
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        default: 20,
      },
    },
    additionalProperties: false,
  },
  annotations: {
    title: "List current memory evidence",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
});

function requireShiftContext(env = process.env) {
  const apiUrl = String(env.SHIFT_API_URL || "").replace(/\/+$/, "");
  const sessionId = String(env.SHIFT_THREAD_ID || "");
  const invocationId = String(env.SHIFT_INVOCATION_ID || "");
  const callbackToken = String(env.SHIFT_CALLBACK_TOKEN || "");
  const missing = [];
  if (!apiUrl) missing.push("SHIFT_API_URL");
  if (!sessionId) missing.push("SHIFT_THREAD_ID");
  if (!invocationId) missing.push("SHIFT_INVOCATION_ID");
  if (!callbackToken) missing.push("SHIFT_CALLBACK_TOKEN");
  if (missing.length > 0) {
    throw new Error(`Missing Shift MCP environment: ${missing.join(", ")}`);
  }
  return { apiUrl, sessionId, invocationId, callbackToken };
}

async function callMemoryWrite(
  args,
  { env = process.env, fetchImpl = globalThis.fetch } = {}
) {
  validateMemoryWriteArguments(args);
  if (typeof fetchImpl !== "function") {
    throw new Error("Global fetch is unavailable; Node 20+ is required.");
  }
  const context = requireShiftContext(env);
  const response = await fetchImpl(
    new URL("/api/callbacks/memory-write", `${context.apiUrl}/`),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        "X-Callback-Token": context.callbackToken,
      },
      body: JSON.stringify({
        sessionId: context.sessionId,
        invocationId: context.invocationId,
        callbackToken: context.callbackToken,
        kind: args?.kind,
        topic: args?.topic,
        content: args?.content,
        scope: args?.scope,
        ...(args?.evidenceEventNo === undefined
          ? {}
          : { evidenceEventNo: args.evidenceEventNo }),
      }),
    }
  );
  const text = await response.text();
  let value;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    value = { error: text || "Invalid response from Shift." };
  }
  if (!response.ok) {
    if (response.status === 400) {
      return {
        outcome: "rejected",
        code: value?.code || "invalid_candidate",
        reason: value?.reason || value?.error || "Memory candidate was rejected.",
      };
    }
    throw new Error(value?.error || `Shift memory_write failed with HTTP ${response.status}.`);
  }
  return {
    outcome: value.outcome,
    memoryId: value.memoryId || value.memory?.id || null,
    ...(value.replacedMemoryId
      ? { replacedMemoryId: value.replacedMemoryId }
      : {}),
  };
}

async function callMemoryEvidenceList(
  args = {},
  { env = process.env, fetchImpl = globalThis.fetch } = {}
) {
  validateMemoryEvidenceListArguments(args);
  if (typeof fetchImpl !== "function") {
    throw new Error("Global fetch is unavailable; Node 20+ is required.");
  }
  const context = requireShiftContext(env);
  const url = new URL("/api/callbacks/memory-evidence", `${context.apiUrl}/`);
  url.searchParams.set("sessionId", context.sessionId);
  url.searchParams.set("invocationId", context.invocationId);
  if (args.limit !== undefined) url.searchParams.set("limit", String(args.limit));
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Callback-Token": context.callbackToken,
    },
  });
  const text = await response.text();
  let value;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    value = { error: text || "Invalid response from Shift." };
  }
  if (!response.ok) {
    throw new Error(
      value?.error || `Shift memory_evidence_list failed with HTTP ${response.status}.`
    );
  }
  return {
    invocationId: value.invocationId || context.invocationId,
    events: Array.isArray(value.events) ? value.events : [],
    hasMore: Boolean(value.hasMore),
  };
}

function validateMemoryWriteArguments(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("memory_write arguments must be an object.");
  }
  const allowed = new Set([
    "kind",
    "topic",
    "content",
    "scope",
    "evidenceEventNo",
  ]);
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`memory_write received unknown fields: ${unknown.join(", ")}.`);
  }
  if (!["decision", "constraint", "fact"].includes(args.kind)) {
    throw new Error("memory_write kind must be decision, constraint, or fact.");
  }
  if (
    typeof args.topic !== "string" ||
    !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(args.topic) ||
    args.topic.length < 3 ||
    args.topic.length > 80
  ) {
    throw new Error("memory_write topic must be a stable lowercase ASCII key.");
  }
  if (
    typeof args.content !== "string" ||
    args.content.trim().length < 10 ||
    args.content.trim().length > 500
  ) {
    throw new Error("memory_write content must contain 10 to 500 characters.");
  }
  if (!["thread", "project"].includes(args.scope)) {
    throw new Error("memory_write scope must be thread or project.");
  }
  if (
    args.evidenceEventNo !== undefined &&
    (!Number.isInteger(args.evidenceEventNo) || args.evidenceEventNo < 0)
  ) {
    throw new Error("memory_write evidenceEventNo must be a non-negative integer.");
  }
  if (args.evidenceEventNo !== undefined && args.kind !== "fact") {
    throw new Error("memory_write evidenceEventNo is only valid for fact memories.");
  }
}

function validateMemoryEvidenceListArguments(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("memory_evidence_list arguments must be an object.");
  }
  const unknown = Object.keys(args).filter((key) => key !== "limit");
  if (unknown.length > 0) {
    throw new Error(
      `memory_evidence_list received unknown fields: ${unknown.join(", ")}.`
    );
  }
  if (
    args.limit !== undefined &&
    (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50)
  ) {
    throw new Error("memory_evidence_list limit must be an integer from 1 to 50.");
  }
}

function createRequestHandler({
  memoryWrite = callMemoryWrite,
  memoryEvidenceList = callMemoryEvidenceList,
} = {}) {
  return async function handleRequest(request) {
    if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return jsonRpcError(request?.id ?? null, -32600, "Invalid Request");
    }

    if (request.method === "notifications/initialized") return null;
    if (request.method === "ping") return jsonRpcResult(request.id, {});

    if (request.method === "initialize") {
      return jsonRpcResult(request.id, {
        protocolVersion: request.params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }

    if (request.method === "tools/list") {
      return jsonRpcResult(request.id, {
        tools: [MEMORY_WRITE_TOOL, MEMORY_EVIDENCE_LIST_TOOL],
      });
    }

    if (request.method === "tools/call") {
      const toolName = request.params?.name;
      if (
        toolName !== MEMORY_WRITE_TOOL.name &&
        toolName !== MEMORY_EVIDENCE_LIST_TOOL.name
      ) {
        return jsonRpcError(request.id, -32602, "Unknown tool.");
      }
      try {
        const result =
          toolName === MEMORY_WRITE_TOOL.name
            ? await memoryWrite(request.params?.arguments || {})
            : await memoryEvidenceList(request.params?.arguments || {});
        return jsonRpcResult(request.id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
          isError: false,
        });
      } catch (error) {
        return jsonRpcResult(request.id, {
          content: [{ type: "text", text: String(error.message || error) }],
          isError: true,
        });
      }
    }

    return jsonRpcError(request.id ?? null, -32601, "Method not found");
  };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function main() {
  const handleRequest = createRequestHandler();
  const input = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  for await (const line of input) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify(jsonRpcError(null, -32700, "Parse error"))}\n`);
      continue;
    }
    const response = await handleRequest(request);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[shift-context-mcp] ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  MEMORY_WRITE_TOOL,
  MEMORY_EVIDENCE_LIST_TOOL,
  requireShiftContext,
  callMemoryWrite,
  callMemoryEvidenceList,
  validateMemoryWriteArguments,
  validateMemoryEvidenceListArguments,
  createRequestHandler,
  jsonRpcResult,
  jsonRpcError,
};

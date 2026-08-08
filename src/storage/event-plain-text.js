const MAX_PLAIN_CHARS = 4000;
const MAX_TOOL_OUTPUT_CHARS = 800;

/**
 * Project an invocation event into human-readable recall index text.
 * Prefer natural language fields over whole-payload JSON (R4).
 */
function eventPlainText(kind, payload) {
  const eventKind = typeof kind === "string" ? kind : "unknown";
  const data = normalizePayload(payload);

  if (
    eventKind === "text.delta" ||
    eventKind === "commentary.delta" ||
    eventKind === "thinking.delta" ||
    eventKind === "stderr"
  ) {
    return truncate(stringField(data, ["text", "content", "message"]));
  }

  if (eventKind === "callback-post" || eventKind === "user-prompt" || eventKind === "message") {
    return truncate(stringField(data, ["content", "text", "message"]));
  }

  if (eventKind === "handoff" || eventKind === "handoff-parsed") {
    return truncate(renderHandoffPlain(data));
  }

  if (eventKind === "memory-captured") {
    return truncate(
      [
        data.kind ? `memory:${data.kind}` : "memory",
        data.status || "",
        data.captureKey || "",
        data.content || "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  if (eventKind.startsWith("tool.") || eventKind === "tool_use" || eventKind === "tool_result") {
    return truncate(renderToolPlain(eventKind, data));
  }

  if (eventKind === "invocation-start") {
    return truncate(
      ["invocation-start", data.agent || data.agentId || "", data.resumeSessionId || ""]
        .filter(Boolean)
        .join(" ")
    );
  }

  if (eventKind === "invocation-end") {
    return truncate(
      ["invocation-end", `code=${data.code ?? ""}`, data.signal ? `signal=${data.signal}` : ""]
        .filter(Boolean)
        .join(" ")
    );
  }

  if (eventKind === "a2a-route" || eventKind === "a2a-skipped") {
    return truncate(
      [eventKind, data.from || "", data.to || "", data.reason || ""].filter(Boolean).join(" ")
    );
  }

  if (eventKind === "sealed" || eventKind === "context-warning") {
    return truncate(
      [
        eventKind,
        data.agent || "",
        data.reason || "",
        data.ratio != null ? `ratio=${data.ratio}` : "",
      ]
        .filter(Boolean)
        .join(" ")
    );
  }

  if (eventKind === "usage.update") {
    return truncate(
      [
        "usage",
        data.scope || "",
        data.inputTokens != null ? `input=${data.inputTokens}` : "",
        data.cachedInputTokens != null ? `cached=${data.cachedInputTokens}` : "",
        data.outputTokens != null ? `output=${data.outputTokens}` : "",
        data.reasoningTokens != null ? `reasoning=${data.reasoningTokens}` : "",
        data.totalTokens != null ? `total=${data.totalTokens}` : "",
        data.costUsd != null ? `cost_usd=${data.costUsd}` : "",
      ]
        .filter(Boolean)
        .join(" ")
    );
  }

  return truncate(renderLimitedFields(data));
}

function normalizePayload(payload) {
  if (payload == null) return {};
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      return { text: payload };
    } catch {
      return { text: payload };
    }
  }
  if (typeof payload === "object" && !Array.isArray(payload)) return payload;
  return { text: String(payload) };
}

function stringField(data, keys) {
  for (const key of keys) {
    if (typeof data[key] === "string" && data[key]) return data[key];
  }
  return "";
}

function renderHandoffPlain(data) {
  const lines = ["handoff"];
  for (const key of ["to", "goal", "what", "why", "next_action", "tradeoff"]) {
    if (typeof data[key] === "string" && data[key].trim()) {
      lines.push(`${key}: ${data[key].trim()}`);
    }
  }
  for (const key of ["files", "evidence", "open_questions", "missing"]) {
    if (Array.isArray(data[key]) && data[key].length > 0) {
      lines.push(`${key}: ${data[key].join(", ")}`);
    }
  }
  if (data.ok === false || data.degraded) lines.push("quality: degraded");
  if (data.ok === true) lines.push("quality: ok");
  if (lines.length === 1 && typeof data.summary === "string") lines.push(data.summary);
  if (lines.length === 1) return renderLimitedFields(data);
  return lines.join("\n");
}

function renderToolPlain(kind, data) {
  const name = data.name || data.tool || data.toolName || kind;
  const parts = [`tool ${name}`];
  if (typeof data.path === "string" && data.path) parts.push(`path=${data.path}`);
  if (typeof data.command === "string" && data.command) {
    parts.push(`command=${truncate(data.command, 200)}`);
  }
  const output = stringField(data, ["output", "result", "content", "text"]);
  if (output) parts.push(truncate(output, MAX_TOOL_OUTPUT_CHARS));
  if (typeof data.error === "string" && data.error) parts.push(`error=${data.error}`);
  return parts.join("\n");
}

function renderLimitedFields(data) {
  const preferred = [
    "text",
    "content",
    "message",
    "summary",
    "name",
    "path",
    "command",
    "agent",
    "from",
    "to",
    "reason",
    "status",
    "kind",
  ];
  const parts = [];
  for (const key of preferred) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) {
      parts.push(`${key}=${value.trim()}`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${value}`);
    }
  }
  if (parts.length > 0) return parts.join(" ");

  // Last resort: shallow non-object fields only (never nested JSON dumps).
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string" && value.trim()) {
      parts.push(`${key}=${value.trim().slice(0, 120)}`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${value}`);
    }
    if (parts.length >= 6) break;
  }
  return parts.join(" ");
}

function truncate(value, maxChars = MAX_PLAIN_CHARS) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

module.exports = {
  MAX_PLAIN_CHARS,
  eventPlainText,
};

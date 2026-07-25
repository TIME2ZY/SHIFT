const { StringDecoder } = require("node:string_decoder");

const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
const MAX_COMMAND_BYTES = 8 * 1024;
const MAX_DIAGNOSTIC_RAW_BYTES = 32 * 1024;
const TRUNCATION_MARKER = "\n…[truncated]";

function utf8Bytes(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function utf8Prefix(value, maxBytes) {
  if (maxBytes <= 0) return "";
  const decoder = new StringDecoder("utf8");
  return decoder.write(Buffer.from(value, "utf8").subarray(0, maxBytes));
}

function truncateUtf8(value, maxBytes, marker = TRUNCATION_MARKER) {
  const text = String(value ?? "");
  const originalBytes = utf8Bytes(text);
  if (originalBytes <= maxBytes) {
    return {
      value: text,
      truncated: false,
      originalBytes,
      originalChars: text.length,
    };
  }

  const markerBytes = utf8Bytes(marker);
  if (markerBytes >= maxBytes) {
    return {
      value: utf8Prefix(marker, maxBytes),
      truncated: true,
      originalBytes,
      originalChars: text.length,
    };
  }
  const budget = Math.max(0, maxBytes - markerBytes);
  return {
    value: `${utf8Prefix(text, budget)}${marker}`,
    truncated: true,
    originalBytes,
    originalChars: text.length,
  };
}

function limitStringField(target, field, maxBytes, metadataPrefix) {
  if (!target || typeof target[field] !== "string") return false;
  const limited = truncateUtf8(target[field], maxBytes);
  if (!limited.truncated) return false;
  const title = `${metadataPrefix.charAt(0).toUpperCase()}${metadataPrefix.slice(1)}`;
  target[field] = limited.value;
  target[`${metadataPrefix}Truncated`] = true;
  target[`original${title}Bytes`] = limited.originalBytes;
  target[`original${title}Chars`] = limited.originalChars;
  return true;
}

function limitStructuredResult(event) {
  if (!event || event.result == null || typeof event.result === "string") return;
  let serialized;
  try {
    serialized = JSON.stringify(event.result);
  } catch {
    return;
  }
  const limited = truncateUtf8(serialized, MAX_TOOL_OUTPUT_BYTES);
  if (!limited.truncated) return;
  event.result = {
    _truncated: true,
    _originalBytes: limited.originalBytes,
    _originalChars: limited.originalChars,
    preview: limited.value,
  };
  event.resultTruncated = true;
  event.originalResultBytes = limited.originalBytes;
  event.originalResultChars = limited.originalChars;
}

function limitCanonicalEvent(event) {
  if (!event || typeof event !== "object") return event;
  const next = { ...event };

  if (next.type === "tool.started" || next.type === "tool.finished") {
    if (next.args && typeof next.args === "object" && !Array.isArray(next.args)) {
      next.args = { ...next.args };
      limitStringField(next.args, "command", MAX_COMMAND_BYTES, "command");
    }

    // Some adapters expose the exact same command output under both aliases.
    // Keep one canonical copy before applying the byte limit.
    if (
      typeof next.output === "string" &&
      typeof next.result === "string" &&
      next.output === next.result
    ) {
      delete next.result;
    }

    limitStringField(next, "output", MAX_TOOL_OUTPUT_BYTES, "output");
    limitStringField(next, "result", MAX_TOOL_OUTPUT_BYTES, "result");
    limitStructuredResult(next);
  }

  if (
    next.type === "diagnostic" &&
    next.providerRaw &&
    typeof next.providerRaw === "object" &&
    !Array.isArray(next.providerRaw)
  ) {
    next.providerRaw = { ...next.providerRaw };
    limitStringField(next.providerRaw, "text", MAX_DIAGNOSTIC_RAW_BYTES, "text");
  }

  return next;
}

module.exports = {
  MAX_TOOL_OUTPUT_BYTES,
  MAX_COMMAND_BYTES,
  MAX_DIAGNOSTIC_RAW_BYTES,
  TRUNCATION_MARKER,
  utf8Bytes,
  truncateUtf8,
  limitCanonicalEvent,
};

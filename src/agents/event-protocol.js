/** Canonical agent event protocol (provider adapters → server → frontend).
 *
 * Platform contract only. Nested subagents are not first-class events; they
 * surface as tool.* (e.g. spawn_subagent / get_command_or_subagent_output).
 * Cross-agent work uses platform @ / handoff (see collaboration-rules).
 * Shell/command executions map to tool.* (toolName often "command_execution" / "bash").
 */
const PROTOCOL_VERSION = 2;

const CANONICAL_EVENT_FIELDS = {
  "run.started": ["agent", "invocationId", "provider", "model"],
  "run.finished": ["agent", "invocationId", "exitCode"],
  "run.failed": ["agent", "invocationId", "error"],
  "text.delta": ["agent", "invocationId", "text"],
  "commentary.delta": ["agent", "invocationId", "text"],
  "thinking.delta": ["agent", "invocationId", "text"],
  stderr: ["agent", "invocationId", "text"],
  "file.changed": ["agent", "invocationId", "path"],
  "progress.update": ["agent", "invocationId", "items"],
  "usage.update": ["agent", "invocationId", "scope", "mode"],
  "tool.started": ["agent", "invocationId", "toolName", "toolId"],
  "tool.finished": ["agent", "invocationId", "toolName", "toolId"],
  /** Unrecognized / non-UI diagnostics (debug & durable optional). */
  diagnostic: ["agent", "invocationId", "code"],
};

/**
 * Per-field type expectations for required and common optional fields.
 * Optional fields are only checked when present on the event.
 */
const FIELD_TYPES = {
  agent: "string",
  invocationId: "string",
  provider: "string",
  model: "string",
  text: "string",
  error: "string",
  path: "string",
  toolName: "string",
  toolId: "string",
  title: "string",
  label: "string",
  toolKind: "string",
  items: "array",
  exitCode: "numberOrNull",
  signal: "stringOrNull",
  // Optional documented fields
  sessionId: "string",
  status: "string",
  failureSource: "stringOrNull",
  failureReason: "stringOrNull",
  changeType: "string",
  output: "string",
  code: "string",
  message: "string",
  rawType: "string",
  severity: "string",
  fingerprint: "string",
  visibility: "string",
  args: "object",
  scope: "string",
  mode: "string",
  inputTokens: "number",
  cachedInputTokens: "number",
  outputTokens: "number",
  reasoningTokens: "number",
  totalTokens: "number",
  costUsd: "number",
  contextTokens: "nonNegativeNumberOrNull",
  contextTokensExact: "boolean",
  providerRaw: "object",
  affectsRun: "boolean",
  retryable: "boolean",
  count: "number",
  outputTruncated: "boolean",
  resultTruncated: "boolean",
  originalOutputBytes: "number",
  originalOutputChars: "number",
  originalResultBytes: "number",
  originalResultChars: "number",
};

const CANONICAL_EVENT_TYPES = new Set(Object.keys(CANONICAL_EVENT_FIELDS));
const STRING_COERCE_FIELDS = [
  "agent",
  "invocationId",
  "provider",
  "model",
  "text",
  "error",
  "path",
  "toolName",
  "toolId",
  "title",
  "label",
  "toolKind",
  "sessionId",
  "status",
  "failureSource",
  "failureReason",
  "changeType",
  "output",
  "code",
  "message",
  "rawType",
  "severity",
  "fingerprint",
  "visibility",
  "scope",
  "mode",
];

function normalizeProgressItem(item, index) {
  const source = item && typeof item === "object" ? item : { text: String(item || "") };
  const label = source.label || source.text || source.title || source.description || "";
  let status = source.status || "";
  if (!status) status = source.done === true ? "completed" : "pending";
  if (status === "done" || status === "success" || status === "ok") status = "completed";
  if (status === "running") status = "in_progress";
  return {
    ...source,
    id: source.id ?? source.step ?? `step-${index + 1}`,
    label,
    status,
    text: source.text || label,
    done: status === "completed",
  };
}

function coerceStringField(value) {
  if (typeof value === "string") return value;
  if (value == null) return value;
  return String(value);
}

function coerceExitCode(value) {
  if (value === null || value === undefined) return value === undefined ? undefined : null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeCanonicalEvent(event) {
  if (!event || typeof event !== "object") return event;
  const next = {
    ...event,
    protocolVersion:
      typeof event.protocolVersion === "number" && Number.isFinite(event.protocolVersion)
        ? event.protocolVersion
        : PROTOCOL_VERSION,
  };

  for (const key of STRING_COERCE_FIELDS) {
    if (next[key] !== undefined && next[key] !== null && typeof next[key] !== "string") {
      next[key] = coerceStringField(next[key]);
    }
  }

  if (next.exitCode !== undefined) {
    next.exitCode = coerceExitCode(next.exitCode);
  }
  if (next.signal !== undefined && next.signal !== null && typeof next.signal !== "string") {
    next.signal = String(next.signal);
  }

  if (next.type === "progress.update") {
    next.items = Array.isArray(next.items) ? next.items.map(normalizeProgressItem) : [];
  }
  if (next.type === "tool.started") {
    next.state = "running";
  }
  if (next.type === "tool.finished") {
    const failed = next.status === "error" || next.status === "failed";
    next.state = failed ? "failed" : "completed";
  }
  if (next.type === "usage.update") {
    const numericFields = [
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "reasoningTokens",
      "totalTokens",
      "costUsd",
      "contextTokens",
    ];
    for (const field of numericFields) {
      if (next[field] === undefined || next[field] === null) continue;
      const value = Number(next[field]);
      if (Number.isFinite(value) && value >= 0) next[field] = value;
    }
  }
  return next;
}

function typeError(field, expected, value) {
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  return `${field} must be ${expected} (got ${actual})`;
}

function checkFieldType(field, value) {
  const kind = FIELD_TYPES[field];
  if (!kind) return null;
  if (kind === "string") {
    if (typeof value !== "string") return typeError(field, "a string", value);
    return null;
  }
  if (kind === "array") {
    if (!Array.isArray(value)) return typeError(field, "an array", value);
    return null;
  }
  if (kind === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return typeError(field, "a plain object", value);
    }
    return null;
  }
  if (kind === "numberOrNull") {
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
      return typeError(field, "a number or null", value);
    }
    return null;
  }
  if (kind === "nonNegativeNumberOrNull") {
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      return typeError(field, "a non-negative number or null", value);
    }
    return null;
  }
  if (kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return typeError(field, "a non-negative number", value);
    }
    return null;
  }
  if (kind === "boolean") {
    if (typeof value !== "boolean") return typeError(field, "a boolean", value);
    return null;
  }
  if (kind === "stringOrNull") {
    if (value !== null && typeof value !== "string") {
      return typeError(field, "a string or null", value);
    }
    return null;
  }
  return null;
}

function validateCanonicalEvent(event) {
  if (!event || typeof event !== "object") return ["event must be an object"];
  if (!CANONICAL_EVENT_TYPES.has(event.type)) {
    return [`unsupported event type "${event.type}"`];
  }
  const errors = [];
  if (
    event.protocolVersion !== undefined &&
    event.protocolVersion !== null &&
    (typeof event.protocolVersion !== "number" ||
      !Number.isFinite(event.protocolVersion) ||
      event.protocolVersion < 1)
  ) {
    errors.push("protocolVersion must be a positive number");
  }
  if (typeof event.protocolVersion === "number" && event.protocolVersion > PROTOCOL_VERSION) {
    errors.push(`unsupported protocolVersion ${event.protocolVersion} (max ${PROTOCOL_VERSION})`);
  }

  for (const field of CANONICAL_EVENT_FIELDS[event.type]) {
    if (event[field] === undefined || event[field] === null) {
      if (field === "exitCode" && event[field] === null) {
        // allowed
      } else {
        errors.push(`${event.type}.${field} is required`);
        continue;
      }
    }
    const typeErr = checkFieldType(field, event[field]);
    if (typeErr) errors.push(`${event.type}.${typeErr}`);
  }

  for (const [field, value] of Object.entries(event)) {
    if (value === undefined || CANONICAL_EVENT_FIELDS[event.type].includes(field)) continue;
    if (!FIELD_TYPES[field]) continue;
    const typeErr = checkFieldType(field, value);
    if (typeErr) errors.push(`${event.type}.${typeErr}`);
  }

  if (event.type === "usage.update") {
    if (!["step", "turn", "run"].includes(event.scope)) {
      errors.push("usage.update.scope must be one of step, turn, run");
    }
    if (!["delta", "cumulative"].includes(event.mode)) {
      errors.push("usage.update.mode must be one of delta, cumulative");
    }
    const tokenFields = [
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "reasoningTokens",
      "totalTokens",
      "costUsd",
      "contextTokens",
    ];
    if (!tokenFields.some((field) => event[field] !== undefined && event[field] !== null)) {
      errors.push("usage.update must include at least one usage value");
    }
  }
  if (event.type === "diagnostic") {
    if (
      event.severity !== undefined &&
      !["debug", "diagnostic", "warning", "error"].includes(event.severity)
    ) {
      errors.push("diagnostic.severity must be one of debug, diagnostic, warning, error");
    }
    if (
      event.visibility !== undefined &&
      !["hidden", "details", "inline"].includes(event.visibility)
    ) {
      errors.push("diagnostic.visibility must be one of hidden, details, inline");
    }
  }

  return errors;
}

function assertCanonicalEvent(event) {
  const normalized = normalizeCanonicalEvent(event);
  const errors = validateCanonicalEvent(normalized);
  if (errors.length) throw new Error(`Invalid canonical event: ${errors.join("; ")}`);
  return normalized;
}

function makeEvent(type, fields) {
  return normalizeCanonicalEvent({ type, protocolVersion: PROTOCOL_VERSION, ...fields });
}

function lifecyclePhase(type) {
  if (type === "run.started") return "start";
  if (type === "run.finished" || type === "run.failed") return "terminal";
  return "content";
}

/**
 * Track run.started → content → single terminal. Pure helper for tests and envelope.
 * @returns {{ started: boolean, terminal: boolean, accept: (type: string) => boolean }}
 */
function createRunLifecycle() {
  let started = false;
  let terminal = false;
  return {
    get started() {
      return started;
    },
    get terminal() {
      return terminal;
    },
    accept(type) {
      const phase = lifecyclePhase(type);
      if (phase === "start") {
        if (terminal || started) return false;
        started = true;
        return true;
      }
      if (phase === "terminal") {
        if (terminal) return false;
        started = true;
        terminal = true;
        return true;
      }
      if (terminal) return false;
      return true;
    },
    markStarted() {
      if (!terminal) started = true;
    },
    markTerminal() {
      started = true;
      terminal = true;
    },
  };
}

module.exports = {
  PROTOCOL_VERSION,
  CANONICAL_EVENT_FIELDS,
  CANONICAL_EVENT_TYPES,
  FIELD_TYPES,
  normalizeProgressItem,
  normalizeCanonicalEvent,
  validateCanonicalEvent,
  assertCanonicalEvent,
  makeEvent,
  lifecyclePhase,
  createRunLifecycle,
};

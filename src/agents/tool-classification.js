const SUBAGENT_NAME_RE =
  /^(spawn[_-]?agent|spawn[_-]?subagent|wait[_-]?agent|subagent|task|agent[_-]?tool)\b/i;
const ANSI_COLOR_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

function parseMaybeJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toolNameFromItem(item) {
  if (!item || typeof item !== "object") return "";
  return String(
    item.tool || item.tool_name || item.toolName || item.name || item.function || ""
  ).trim();
}

function toolArgsFromItem(item) {
  if (!item || typeof item !== "object") return {};
  const state = asObject(item.state);
  const direct =
    asObject(item.arguments) ||
    asObject(item.args) ||
    asObject(item.input) ||
    asObject(item.params) ||
    (state && (asObject(state.input) || asObject(state.arguments) || asObject(state.args))) ||
    parseMaybeJson(item.arguments) ||
    parseMaybeJson(item.args) ||
    parseMaybeJson(item.input) ||
    (state && (parseMaybeJson(state.input) || parseMaybeJson(state.arguments)));
  return direct || {};
}

function toolResultFromItem(item) {
  if (!item || typeof item !== "object")
    return item?.result ?? item?.output ?? item?.content ?? null;
  const state = asObject(item.state);
  if (item.result !== undefined) return item.result;
  if (item.output !== undefined) return item.output;
  if (item.content !== undefined) return item.content;
  if (state) {
    if (state.result !== undefined) return state.result;
    if (state.output !== undefined) return state.output;
    if (state.error !== undefined) return { error: state.error };
  }
  if (item.error !== undefined) return { error: item.error };
  return null;
}

function isFailedItem(item) {
  if (!item || typeof item !== "object") return false;
  const status = String(item.status || item.state || "").toLowerCase();
  if (["failed", "error", "errored", "cancelled", "canceled"].includes(status)) return true;
  if (item.error || item.is_error === true || item.success === false) return true;
  const exitCode = exitCodeFromItem(item);
  if (exitCode !== null && exitCode !== 0) return true;
  return false;
}

function exitCodeFromItem(item) {
  if (!item || typeof item !== "object") return null;
  const state = asObject(item.state);
  const candidates = [
    item.exitCode,
    item.exit_code,
    item.code,
    state && state.exitCode,
    state && state.exit_code,
    state && state.code,
  ];
  for (const value of candidates) {
    if (value === null || value === undefined || value === "") continue;
    const code = Number(value);
    if (Number.isInteger(code)) return code;
  }
  return null;
}

function providerFailureStatus(item) {
  if (!item || typeof item !== "object") return "";
  const state = asObject(item.state);
  const candidates = [
    item.status,
    typeof item.state === "string" ? item.state : null,
    state && state.status,
    state && state.state,
  ];
  for (const value of candidates) {
    const status = String(value || "")
      .trim()
      .toLowerCase();
    if (["failed", "error", "errored", "cancelled", "canceled"].includes(status)) {
      return status;
    }
  }
  if (item.error || (state && state.error) || item.is_error === true || item.success === false) {
    return "error";
  }
  return "";
}

function resultTextForClassification(item) {
  const result = toolResultFromItem(item);
  if (typeof result === "string") return result;
  if (result === undefined || result === null) return "";
  const summary = summarizeResult(result, 200000);
  try {
    return [summary, JSON.stringify(result)].filter(Boolean).join("\n");
  } catch {
    return summary;
  }
}

const SHELL_FAILURE_SIGNATURES = [
  { label: "fatal:", pattern: /(?:^|\r?\n)\s*fatal:\s*\S/i },
  {
    label: "pull request create failed:",
    pattern: /(?:^|\r?\n)\s*pull request create failed:\s*\S/i,
  },
  { label: "npm ERR!", pattern: /(?:^|\r?\n)\s*npm ERR!\s*\S?/i },
  {
    label: "PowerShell command not recognized",
    pattern: /\bThe term\s+['"][^'"\r\n]+['"]\s+is not recognized\b/i,
  },
  { label: "CommandNotFoundException", pattern: /\bCommandNotFoundException\b/i },
  { label: "FullyQualifiedErrorId", pattern: /\bFullyQualifiedErrorId\s*:/i },
];

function shellFailureSignature(item) {
  const text = resultTextForClassification(item);
  if (!text) return null;
  const plain = text.replace(ANSI_COLOR_RE, "");
  return SHELL_FAILURE_SIGNATURES.find(({ pattern }) => pattern.test(plain)) || null;
}

function isShellLikeTool(toolName, args) {
  const name = String(toolName || "")
    .trim()
    .toLowerCase();
  if (
    [
      "bash",
      "shell",
      "exec",
      "command_execution",
      "run_terminal_cmd",
      "powershell",
      "pwsh",
    ].includes(name) ||
    name.endsWith(".bash") ||
    name.includes("shell") ||
    name.includes("terminal")
  ) {
    return true;
  }
  return Boolean(
    args &&
    typeof args === "object" &&
    (typeof args.command === "string" || typeof args.cmd === "string")
  );
}

/**
 * Classify a shell/tool result without treating generic words such as "error"
 * as proof that the command failed. Provider state and real exit codes remain
 * authoritative; output signatures only cover providers that incorrectly
 * report a successful/zero outcome.
 */
function classifyShellOutcome(item, { toolName = "", args = {} } = {}) {
  const reportedExitCode = exitCodeFromItem(item);
  const providerStatus = providerFailureStatus(item);
  if (providerStatus) {
    const result = toolResultFromItem(item);
    const detail = summarizeResult(item?.error ?? result, 180);
    return {
      failed: true,
      exitCode: reportedExitCode,
      failureSource: "provider-status",
      failureReason: detail || `Provider reported ${toolName || "tool"} status ${providerStatus}`,
    };
  }

  if (reportedExitCode !== null && reportedExitCode !== 0) {
    return {
      failed: true,
      exitCode: reportedExitCode,
      failureSource: "exit-code",
      failureReason: `${toolName || "Shell command"} exited with code ${reportedExitCode}`,
    };
  }

  const signature = isShellLikeTool(toolName || toolNameFromItem(item), args)
    ? shellFailureSignature(item)
    : null;
  if (signature) {
    const command =
      args && typeof args === "object" && typeof (args.command || args.cmd) === "string"
        ? ` (${String(args.command || args.cmd).slice(0, 120)})`
        : "";
    return {
      failed: true,
      exitCode: reportedExitCode,
      failureSource: "output-signature",
      failureReason: `${toolName || "Shell output"}${command} matched ${signature.label}`,
    };
  }

  return {
    failed: false,
    exitCode: reportedExitCode ?? 0,
    failureSource: null,
    failureReason: null,
  };
}

function shellOutputLooksFailed(item) {
  return Boolean(shellFailureSignature(item));
}

function isSubagentTool(toolName, args = {}) {
  const name = String(toolName || "").trim();
  if (!name) return false;
  if (SUBAGENT_NAME_RE.test(name)) return true;
  const lower = name.toLowerCase();
  if (lower.includes("subagent") || lower.includes("spawn_agent") || lower.includes("wait_agent")) {
    return true;
  }
  const obj = asObject(args) || {};
  if (obj.subagent_type || obj.subagentType || obj.agent_type || obj.agentType) return true;
  if (
    (lower === "task" || lower.endsWith(".task") || lower.includes("task")) &&
    (obj.prompt || obj.description || obj.agent || obj.subagent_type || obj.subagentType)
  ) {
    return true;
  }
  return false;
}

function subagentDisplayName(toolName, args = {}) {
  const obj = asObject(args) || {};
  const typed =
    obj.subagent_type ||
    obj.subagentType ||
    obj.agent_type ||
    obj.agentType ||
    obj.agent ||
    obj.name;
  if (typed) return String(typed);
  return String(toolName || "subagent");
}

function collapseWhitespace(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(text, max = 180) {
  const value = collapseWhitespace(text);
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Strip OpenCode task wrappers and pull the human-readable body.
 * e.g. <task ...><task_result>BODY</task_result></task>
 */
function cleanToolOutput(text) {
  let value = String(text || "");
  if (!value) return "";

  const resultMatch = value.match(/<task_result>\s*([\s\S]*?)\s*<\/task_result>/i);
  if (resultMatch && resultMatch[1]) value = resultMatch[1];

  value = value
    .replace(/<\/?task\b[^>]*>/gi, " ")
    .replace(/<\/?task_result\b[^>]*>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ");

  // Drop common markdown chrome for card previews.
  value = value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\*\*[^*]+\*\*\s*/gm, "")
    .replace(/\|/g, " ");

  return collapseWhitespace(value);
}

function summarizeTask(args = {}, max = 120) {
  const obj = asObject(args) || {};
  // Prefer short labels over the full multi-line prompt.
  const candidates = [
    obj.title,
    obj.description,
    obj.task,
    obj.goal,
    obj.message,
    obj.query,
    obj.instruction,
    obj.prompt,
  ];
  let text = "";
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      text = value.trim();
      break;
    }
  }
  if (!text) {
    try {
      text = JSON.stringify(obj);
    } catch {
      text = "";
    }
  }
  return truncateText(text, max);
}

function summarizeResult(result, max = 180) {
  if (result == null) return "";
  if (typeof result === "string") {
    return truncateText(cleanToolOutput(result), max);
  }
  if (typeof result === "object") {
    if (typeof result.error === "string" && result.error.trim()) {
      return summarizeResult(result.error, max);
    }
    if (typeof result.message === "string" && result.message.trim()) {
      return summarizeResult(result.message, max);
    }
    if (typeof result.summary === "string" && result.summary.trim()) {
      return summarizeResult(result.summary, max);
    }
    if (typeof result.text === "string" && result.text.trim()) {
      return summarizeResult(result.text, max);
    }
    if (typeof result.output === "string" && result.output.trim()) {
      return summarizeResult(result.output, max);
    }
    try {
      return truncateText(JSON.stringify(result), max);
    } catch {
      return "";
    }
  }
  return truncateText(String(result), max);
}

function toolItemId(item, toolName) {
  if (item && typeof item.callID === "string" && item.callID) return item.callID;
  if (item && typeof item.call_id === "string" && item.call_id) return item.call_id;
  if (item && typeof item.callId === "string" && item.callId) return item.callId;
  if (item && typeof item.id === "string" && item.id) return item.id;
  return `${toolName || "tool"}-${Date.now()}`;
}

module.exports = {
  SUBAGENT_NAME_RE,
  toolNameFromItem,
  toolArgsFromItem,
  toolResultFromItem,
  isFailedItem,
  exitCodeFromItem,
  classifyShellOutcome,
  shellOutputLooksFailed,
  isSubagentTool,
  subagentDisplayName,
  cleanToolOutput,
  summarizeTask,
  summarizeResult,
  toolItemId,
};

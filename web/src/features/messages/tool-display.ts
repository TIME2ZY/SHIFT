import type { InvocationTool } from "./invocation-types";

const SUBAGENT_NAME_RE =
  /^(spawn[_-]?agent|spawn[_-]?subagent|wait[_-]?agent|subagent|task|agent[_-]?tool)\b/i;

export function isSubagentTool(
  toolName: string,
  args?: Record<string, unknown>,
  toolKind?: string
): boolean {
  const name = String(toolName || "").trim();
  if (toolKind === "task" || toolKind === "background_task_action") {
    if (SUBAGENT_NAME_RE.test(name) || name.includes("subagent") || name.includes("TaskOutput")) {
      return true;
    }
  }
  if (!name) return false;
  if (SUBAGENT_NAME_RE.test(name)) return true;
  const lower = name.toLowerCase();
  if (lower.includes("subagent") || lower.includes("spawn_agent") || lower.includes("wait_agent")) {
    return true;
  }
  if (lower.includes("get_command_or_subagent")) return true;
  const obj = args && typeof args === "object" ? args : {};
  if (obj.subagent_type || obj.subagentType || obj.agent_type || obj.agentType) return true;
  return false;
}

export function subagentTypeLabel(args?: Record<string, unknown>): string {
  if (!args || typeof args !== "object") return "";
  const typed =
    args.subagent_type ?? args.subagentType ?? args.agent_type ?? args.agentType ?? args.agent;
  return typed != null && String(typed).trim() ? String(typed).trim() : "";
}

/**
 * Primary heading for a tool card.
 * Prefer human title, then label + description/type, then stable toolName.
 */
export function formatToolPrimaryTitle(tool: Pick<
  InvocationTool,
  "toolName" | "title" | "label" | "toolKind" | "input"
>): string {
  const name = tool.toolName || "tool";
  const title = typeof tool.title === "string" ? tool.title.trim() : "";
  if (title && title !== name) return title;

  const args = tool.input;
  const desc =
    args && typeof args.description === "string" && args.description.trim()
      ? args.description.trim()
      : "";
  const subType = subagentTypeLabel(args);
  if (isSubagentTool(name, args, tool.toolKind)) {
    if (desc) return desc;
    if (subType) return subType;
  }

  if (tool.label && tool.label.trim() && tool.label.trim() !== name) {
    return desc ? `${tool.label.trim()}: ${desc}` : tool.label.trim();
  }
  if (title) return title;
  return name;
}

export function formatToolSecondaryId(tool: Pick<InvocationTool, "toolName" | "title">): string {
  const name = tool.toolName || "tool";
  const title = typeof tool.title === "string" ? tool.title.trim() : "";
  // Show stable id when primary title is human-readable and different.
  if (title && title !== name) return name;
  return "";
}

/** Compact args view: highlight useful keys first for subagent tools. */
export function formatToolArgsForDisplay(
  toolName: string,
  input?: Record<string, unknown>,
  toolKind?: string
): string {
  if (!input || typeof input !== "object") return "";
  const preferred = [
    "description",
    "subagent_type",
    "subagentType",
    "capability_mode",
    "task_ids",
    "timeout_ms",
    "target_directory",
    "path",
    "command",
  ];
  const keys = Object.keys(input);
  if (!keys.length) return "";

  if (isSubagentTool(toolName, input, toolKind) || preferred.some((k) => k in input)) {
    const ordered: Record<string, unknown> = {};
    for (const key of preferred) {
      if (key in input) ordered[key] = input[key];
    }
    // Include remaining keys except huge prompt by default (prompt last if small).
    for (const key of keys) {
      if (key in ordered) continue;
      if (key === "prompt" && typeof input.prompt === "string" && input.prompt.length > 240) {
        ordered.prompt = `${input.prompt.slice(0, 200)}…`;
        continue;
      }
      ordered[key] = input[key];
    }
    try {
      return JSON.stringify(ordered, null, 2);
    } catch {
      return String(input);
    }
  }
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

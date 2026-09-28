/**
 * Display contract for the agent-authored `handoff` fence.
 *
 * Canonical grammar: `src/agents/handoff-parse.js` (field sets + policy
 * evaluation) and `skills/cross-agent-handoff/SKILL.md` (authoring rules).
 * This module only describes how the fence is read back into the UI; it does
 * not decide routing and must not drift from the grammar above.
 */

export const HANDOFF_FENCE_LANG = "handoff";

/** Scalar fields, in the order a handoff should be read. */
export const HANDOFF_SCALAR_FIELDS = [
  "to",
  "intent",
  "goal",
  "what",
  "why",
  "next_action",
  "tradeoff",
] as const;

/** List fields, in the order a handoff should be read. */
export const HANDOFF_LIST_FIELDS = [
  "constraints",
  "prohibited",
  "files",
  "evidence",
  "open_questions",
] as const;

export type HandoffScalarField = (typeof HANDOFF_SCALAR_FIELDS)[number];
export type HandoffListField = (typeof HANDOFF_LIST_FIELDS)[number];
export type HandoffField = HandoffScalarField | HandoffListField;

const SCALAR_LABELS: Record<HandoffScalarField, string> = {
  to: "交接给",
  intent: "交接意图",
  goal: "目标",
  what: "进展",
  why: "为何交接",
  next_action: "下一步",
  tradeoff: "取舍",
};

const LIST_LABELS: Record<HandoffListField, string> = {
  constraints: "约束",
  prohibited: "禁止事项",
  files: "涉及文件",
  evidence: "证据",
  open_questions: "待确认",
};

/** Duty vocabulary, shared with the collaboration task card. */
export const DUTY_LABELS: Record<string, string> = {
  discuss: "讨论",
  plan: "规划",
  implement: "实现",
  fix: "修复",
  review: "审查",
  deliver: "交付",
  accept: "验收",
  recall: "回忆",
};

export function dutyLabel(duty: string | null | undefined): string | null {
  if (!duty) return null;
  return DUTY_LABELS[duty] || duty;
}

export interface HandoffFieldEntry {
  field: string;
  label: string;
  value: string;
}

export interface HandoffListEntry {
  field: string;
  label: string;
  items: string[];
}

export interface HandoffPacket {
  /** Stable identity for React keys. */
  id: string;
  to: string | null;
  intent: string | null;
  intentLabel: string | null;
  scalars: HandoffFieldEntry[];
  lists: HandoffListEntry[];
}

function scalarLabel(field: string): string {
  return SCALAR_LABELS[field as HandoffScalarField] ?? field;
}

function listLabel(field: string): string {
  return LIST_LABELS[field as HandoffListField] ?? field;
}

function isScalarField(field: string): field is HandoffScalarField {
  return (HANDOFF_SCALAR_FIELDS as readonly string[]).includes(field);
}

function isListField(field: string): field is HandoffListField {
  return (HANDOFF_LIST_FIELDS as readonly string[]).includes(field);
}

/**
 * Read the interior of a handoff fence for display.
 *
 * Mirrors `parseHandoffBody` in `src/agents/handoff-parse.js`: scalar values may
 * be continued with the YAML block indicator (`what: |`), list values are `- `
 * items. Returns null when the body carries none of the known fields, so callers
 * can fall back to the raw code block.
 */
export function parseHandoffFence(body: string, id = "handoff"): HandoffPacket | null {
  if (!body || typeof body !== "string") return null;

  const scalars: HandoffFieldEntry[] = [];
  const lists: HandoffListEntry[] = [];
  const scalarIndex = new Map<string, number>();
  const listIndex = new Map<string, number>();

  let current: { field: string; kind: "scalar" | "list"; block: boolean; lines: string[] } | null =
    null;

  const flush = () => {
    if (!current) return;
    if (current.kind === "scalar") {
      const value = current.lines.join("\n").trim();
      if (value) {
        const existing = scalarIndex.get(current.field);
        const entry: HandoffFieldEntry = {
          field: current.field,
          label: scalarLabel(current.field),
          value,
        };
        if (existing === undefined) {
          scalarIndex.set(current.field, scalars.length);
          scalars.push(entry);
        } else {
          scalars[existing] = entry;
        }
      }
    } else {
      const items = current.lines.map((line) => line.trim()).filter(Boolean);
      if (items.length) {
        const existing = listIndex.get(current.field);
        const entry: HandoffListEntry = {
          field: current.field,
          label: listLabel(current.field),
          items,
        };
        if (existing === undefined) {
          listIndex.set(current.field, lists.length);
          lists.push(entry);
        } else {
          lists[existing] = entry;
        }
      }
    }
    current = null;
  };

  for (const rawLine of body.split(/\r?\n/)) {
    const keyMatch = rawLine.match(/^([a-z_]+)\s*:\s*(.*)$/i);
    if (keyMatch) {
      const field = keyMatch[1].toLowerCase();
      const rest = keyMatch[2];
      if (isScalarField(field) || isListField(field)) {
        flush();
        const block = isScalarField(field) && (rest === "|" || rest === "|-" || rest === "|+");
        current = {
          field,
          kind: isScalarField(field) ? "scalar" : "list",
          block,
          lines: [],
        };
        if (isScalarField(field) && rest && !block) {
          current.lines.push(rest.trim());
          flush();
        } else if (isListField(field) && rest.trim()) {
          for (const part of rest.split(",")) {
            const item = part.trim().replace(/^[-*]\s+/, "");
            if (item) current.lines.push(item);
          }
        }
        continue;
      }
    }

    if (!current) continue;

    const line = rawLine.trim();
    if (current.kind === "list") {
      const item = line.replace(/^[-*]\s+/, "").trim();
      if (item) current.lines.push(item);
      continue;
    }

    // Scalar continuation: block scalars keep their text, folded ones stop at a blank line.
    if (current.block || line) {
      if (!current.block && !line) {
        flush();
        continue;
      }
      current.lines.push(rawLine.replace(/\s+$/, ""));
    }
  }
  flush();

  if (!scalars.length && !lists.length) return null;

  const to = scalars.find((entry) => entry.field === "to")?.value ?? null;
  const intent = scalars.find((entry) => entry.field === "intent")?.value ?? null;

  return {
    id,
    to,
    intent,
    intentLabel: intent ? dutyLabel(intent) : null,
    scalars: scalars.filter((entry) => entry.field !== "to" && entry.field !== "intent"),
    lists,
  };
}

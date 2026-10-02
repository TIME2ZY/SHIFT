/**
 * Display contract for agent-authored fenced packets.
 *
 * The grammar lives in each skill's SKILL.md (see skills/cross-agent-handoff,
 * skills/implementation-plan, skills/code-review-deliver) and is consumed for
 * policy by `src/agents/handoff-parse.js` and the task gate recorders. This
 * module only describes how a packet is read back into the UI; it decides
 * nothing and must not drift from those skills.
 */
import MarkdownIt from "markdown-it";
import type { FenceFieldMap, FenceLang } from "../../../../src/shared/fence-format";

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

interface FieldSpec {
  label: string;
  /** Rendered as a copyable identifier chip instead of prose. */
  id?: boolean;
  /** Long text: collapsed behind a summary line. */
  long?: boolean;
  /** Enum values mapped to Chinese before display. */
  values?: Record<string, string>;
}

interface FenceSpec<L extends FenceLang = FenceLang> {
  lang: L;
  title: string;
  scalars: Record<string, FieldSpec>;
  lists: Record<string, FieldSpec>;
  /** Fence body is a JSON object rather than YAML-ish key/value. */
  json?: boolean;
}

/**
 * The field names come from `src/shared/fence-format`, so every fence must
 * label every field its grammar allows. Adding one there and not here is a
 * compile error, not a silent fallback to a raw source block at runtime.
 */
function defineFence<L extends FenceLang>(
  spec: {
    lang: L;
    title: string;
    json?: boolean;
  } & {
    scalars: Record<FenceFieldMap[L]["scalars"], FieldSpec>;
    lists: Record<FenceFieldMap[L]["lists"], FieldSpec>;
  }
): FenceSpec<L> {
  return spec;
}

export interface ContractField {
  key: string;
  label: string;
  value: string;
  id: boolean;
  long: boolean;
}

export interface ContractList {
  key: string;
  label: string;
  items: string[];
}

export interface ContractCard {
  id: string;
  title: string;
  rawBody: string;
  /** Shown on the card head, e.g. the handoff route. */
  badge: string | null;
  fields: ContractField[];
  lists: ContractList[];
}

const VERDICT_LABELS: Record<string, string> = {
  accept: "通过",
  reject: "拒绝",
  approved: "通过",
  approve: "通过",
  changes_requested: "需修改",
  incomplete: "未完成",
};

export const CONTRACT_FENCES: FenceSpec[] = [
  defineFence({
    lang: "delegation_plan",
    title: "委托草稿",
    json: true,
    scalars: { workflowId: { label: "流程" }, goal: { label: "目标", long: true } },
    lists: {
      deliverables: { label: "交付物" },
      acceptanceCriteria: { label: "完成条件" },
      subtasks: { label: "分任务" },
    },
  }),
  defineFence({
    lang: "handoff",
    title: "交接",
    scalars: {
      to: { label: "交接给" },
      intent: { label: "交接意图", values: DUTY_LABELS },
      goal: { label: "目标", long: true },
      what: { label: "进展", long: true },
      why: { label: "为何交接", long: true },
      next_action: { label: "下一步" },
      tradeoff: { label: "取舍", long: true },
    },
    lists: {
      constraints: { label: "约束" },
      prohibited: { label: "禁止事项" },
      files: { label: "涉及文件" },
      evidence: { label: "证据" },
      open_questions: { label: "待确认" },
    },
  }),
  defineFence({
    lang: "solution_baseline",
    title: "方案基线",
    scalars: {
      user_goal_hash: { label: "目标哈希", id: true },
      summary: { label: "方案", long: true },
    },
    lists: {
      constraints: { label: "约束" },
      non_goals: { label: "不做的内容" },
      acceptance_criteria: { label: "验收标准" },
    },
  }),
  defineFence({
    lang: "implementation_plan",
    title: "实现计划",
    scalars: {
      summary: { label: "摘要", long: true },
    },
    lists: {
      files: { label: "涉及文件" },
      changes: { label: "改动" },
      tests: { label: "验证" },
      risks: { label: "风险" },
    },
  }),
  defineFence({
    lang: "code_review",
    title: "代码审查",
    scalars: {
      verdict: { label: "结论", values: VERDICT_LABELS },
      summary: { label: "评审结论", long: true },
    },
    lists: {
      findings: { label: "问题" },
      tests: { label: "验证记录" },
    },
  }),
  defineFence({
    lang: "delivery_receipt",
    title: "交付回执",
    scalars: {
      commit_sha: { label: "提交", id: true },
      pr_url: { label: "PR" },
      base_branch: { label: "基线分支" },
    },
    lists: {
      verification: { label: "验证记录" },
    },
  }),
  defineFence({
    lang: "final_acceptance",
    title: "最终验收",
    scalars: {
      verdict: { label: "结论", values: VERDICT_LABELS },
      user_goal_hash: { label: "目标哈希", id: true },
      solution_hash: { label: "方案哈希", id: true },
      implementation_plan_hash: { label: "实现计划哈希", id: true },
      commit_sha: { label: "提交", id: true },
    },
    lists: {
      checks: { label: "核验" },
      gaps: { label: "未满足项" },
    },
  }),
  defineFence({
    lang: "task_progress",
    title: "执行进度",
    json: true,
    scalars: {
      goal_hash: { label: "目标哈希", id: true },
      plan_hash: { label: "计划哈希", id: true },
      current: { label: "当前事项", long: true },
      next_action: { label: "下一步" },
    },
    lists: {
      completed: { label: "已报告完成" },
      remaining: { label: "剩余事项" },
      blockers: { label: "阻塞" },
      verification: { label: "验证记录" },
    },
  }),
  defineFence({
    lang: "task_goal",
    title: "目标修订",
    json: true,
    scalars: {
      goal_hash: { label: "目标哈希", id: true },
      text: { label: "修订后目标", long: true },
      source_message_id: { label: "来源消息", id: true },
    },
    lists: {},
  }),
];

const FENCE_BY_LANG = new Map<string, FenceSpec>(CONTRACT_FENCES.map((spec) => [spec.lang, spec]));

/** Fence languages this module turns into structured cards. */
export const CONTRACT_FENCE_LANGS = CONTRACT_FENCES.map((spec) => spec.lang);

export function contractFenceSpec(lang: string): FenceSpec | undefined {
  return FENCE_BY_LANG.get(lang.toLowerCase());
}

function mapValue(spec: FieldSpec | undefined, raw: string): string {
  return spec?.values?.[raw] ?? raw;
}

/**
 * Read a fence body for display. Scalar values may continue with the YAML
 * block indicator (`summary: |`); list values are `- ` items. Returns null
 * when the body carries none of the known fields so the caller can fall back
 * to the raw source block.
 */
export function parseContractFence(lang: string, body: string, id?: string): ContractCard | null {
  const spec = contractFenceSpec(lang);
  if (!spec || !body || typeof body !== "string") return null;

  const scalarOrder: string[] = [];
  const scalarValue = new Map<string, string>();
  const listOrder: string[] = [];
  const listItems = new Map<string, string[]>();

  const applyScalar = (key: string, value: string) => {
    if (!value) return;
    if (!scalarValue.has(key)) scalarOrder.push(key);
    scalarValue.set(key, value);
  };
  const applyList = (key: string, items: string[]) => {
    if (!items.length) return;
    const existing = listItems.get(key) ?? [];
    if (!listItems.has(key)) listOrder.push(key);
    listItems.set(key, [...existing, ...items]);
  };

  if (spec.json) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.trim());
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(raw)) {
        applyList(
          key,
          raw.map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
        );
      } else if (raw != null && raw !== "") {
        applyScalar(key, typeof raw === "string" ? raw : JSON.stringify(raw));
      }
    }
  } else {
    let current: { key: string; kind: "scalar" | "list"; block: boolean; lines: string[] } | null =
      null;

    const flush = () => {
      if (!current) return;
      if (current.kind === "scalar") {
        applyScalar(current.key, current.lines.join("\n").trim());
      } else {
        applyList(current.key, current.lines.map((line) => line.trim()).filter(Boolean));
      }
      current = null;
    };

    for (const rawLine of body.split(/\r?\n/)) {
      const keyMatch = rawLine.match(/^([a-z_]+)\s*:\s*(.*)$/i);
      if (keyMatch) {
        const key = keyMatch[1].toLowerCase();
        const rest = keyMatch[2];
        const scalarSpec = spec.scalars[key];
        const listSpec = spec.lists[key];
        if (scalarSpec || listSpec) {
          flush();
          const kind = scalarSpec ? "scalar" : "list";
          const block = kind === "scalar" && (rest === "|" || rest === "|-" || rest === "|+");
          current = { key, kind, block, lines: [] };
          if (rest && !block) {
            const items = rest.trim();
            if (kind === "scalar") {
              applyScalar(key, items);
              current = null;
            } else {
              for (const part of items.split(",")) {
                const item = part.trim().replace(/^[-*]\s+/, "");
                if (item) current.lines.push(item);
              }
            }
          }
          continue;
        }
        // The display grammar may lag an agent-authored packet. Do not fold a
        // new top-level field into the preceding known list or scalar.
        flush();
        continue;
      }

      if (!current) continue;
      const line = rawLine.trim();
      if (current.kind === "list") {
        const item = line.replace(/^[-*]\s+/, "").trim();
        if (item) current.lines.push(item);
        continue;
      }
      if (current.block || line) {
        if (!current.block && !line) {
          flush();
          continue;
        }
        current.lines.push(rawLine.replace(/\s+$/, ""));
      }
    }
    flush();
  }

  const fields: ContractField[] = [];
  const lists: ContractList[] = [];
  let badge: string | null = null;

  for (const key of scalarOrder) {
    const fieldSpec = spec.scalars[key];
    const value = mapValue(fieldSpec, scalarValue.get(key) || "");
    if (!value) continue;
    if (key === "to") {
      badge = value;
      continue;
    }
    if (key === "intent") {
      badge = badge ? `${badge} · ${value}` : value;
      continue;
    }
    fields.push({
      key,
      label: fieldSpec.label,
      value,
      id: Boolean(fieldSpec.id),
      long: Boolean(fieldSpec.long),
    });
  }
  for (const key of listOrder) {
    const fieldSpec = spec.lists[key];
    lists.push({ key, label: fieldSpec.label, items: listItems.get(key) || [] });
  }

  if (!fields.length && !lists.length && !badge) return null;

  return {
    id: id ?? `${spec.lang}-${body.length}`,
    title: spec.title,
    rawBody: body,
    badge,
    fields,
    lists,
  };
}

const fenceScanner = new MarkdownIt({ html: false });

/** Only top-level Markdown fences are display contracts. An example inside a
 * longer fence (or a nested list) remains source text. */
export function splitContractFences(content: string): {
  kind: "markdown" | "contract";
  text: string;
  card: ContractCard | null;
}[] {
  const segments: { kind: "markdown" | "contract"; text: string; card: ContractCard | null }[] = [];
  const lineOffsets = [0];
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === "\n") lineOffsets.push(i + 1);
  }
  let cursor = 0;
  let index = 0;
  for (const token of fenceScanner.parse(content, {})) {
    if (token.type !== "fence" || token.level !== 0 || !token.map) continue;
    const lang = token.info.trim().toLowerCase();
    if (!contractFenceSpec(lang)) continue;
    const card = parseContractFence(lang, token.content.trim(), `${lang}-${index}`);
    if (!card) continue;
    const start = lineOffsets[token.map[0]] ?? content.length;
    const end = lineOffsets[token.map[1]] ?? content.length;
    if (start > cursor) {
      segments.push({ kind: "markdown", text: content.slice(cursor, start), card: null });
    }
    segments.push({ kind: "contract", text: "", card });
    cursor = end;
    index += 1;
  }
  if (cursor < content.length) {
    segments.push({ kind: "markdown", text: content.slice(cursor), card: null });
  }
  return segments.length ? segments : [{ kind: "markdown", text: content, card: null }];
}

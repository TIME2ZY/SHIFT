/**
 * Chinese display labels for observability internals.
 *
 * The values below are stored enums (see `src/shared/collab-contracts.js` and
 * the trace read model). They must never be printed as-is: the audit page is a
 * reading surface, not a log tail.
 */

export const TRIGGER_TYPE_LABELS: Record<string, string> = {
  "user-message": "用户消息",
  user_message: "用户消息",
  "a2a-handoff": "交接启动",
  a2a_handoff: "交接启动",
  handoff: "交接启动",
  resume: "续接",
  seal_resume: "续接",
  recovery: "续接",
  repair: "修复启动",
  "invocation-repair": "修复启动",
};

export const HANDOFF_STATUS_LABELS: Record<string, string> = {
  pending: "待处理",
  accepted: "已接收",
  enqueued: "已入队",
  started: "已启动",
  completed: "完成",
  failed: "失败",
  rejected: "已拒绝",
  skipped: "已跳过",
  unknown: "未知",
};

export const MEMORY_KIND_LABELS: Record<string, string> = {
  constraint: "约束",
  decision: "决策",
  preference: "偏好",
  fact: "事实",
  plan: "方案",
  memory: "记忆",
};

export function triggerTypeLabel(value: string | null | undefined): string {
  if (!value) return "调用";
  return TRIGGER_TYPE_LABELS[value] ?? value;
}

export function handoffStatusLabel(value: string | null | undefined): string {
  if (!value) return "未知";
  return HANDOFF_STATUS_LABELS[value] ?? "未知";
}

export function memoryKindLabel(value: string | null | undefined): string {
  if (!value) return "记忆";
  return MEMORY_KIND_LABELS[value] ?? value;
}

const EVIDENCE_KIND_LABELS: Record<string, string> = {
  agent_reported: "Agent 自报",
  platform_verified: "平台已核验",
  derived: "推导得出",
};

export function evidenceKindLabel(value: string): string {
  return EVIDENCE_KIND_LABELS[value] ?? value;
}

/**
 * A memory row should read as what people call it, not what the system named
 * it. Topics like `invocation.e2e.control-observe` are machine slugs; in that
 * case the body's first line says more. A short separator-free topic ("存储")
 * is already a human name and stays the title.
 */
export function memoryTitle(memory: { topic?: string; content?: string }): string {
  const topic = (memory.topic || "").trim();
  const body = (memory.content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  const topicReadsAsName = topic.length > 0 && topic.length <= 32 && !/[._]/.test(topic);
  if (topicReadsAsName) return topic;
  if (body) return body;
  if (topic) return topic.replace(/[._-]+/g, " ").trim();
  return "未命名记忆";
}

/** Error codes stay out of the reading flow; the full code is available on hover. */
export function errorCodeLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return "执行出错";
}

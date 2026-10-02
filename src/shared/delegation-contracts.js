"use strict";

const DELEGATION_STATES = Object.freeze([
  "draft",
  "queued",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
]);
const SOFTWARE_DUTIES = Object.freeze([
  "discuss",
  "plan",
  "implement",
  "review",
  "fix",
  "deliver",
  "accept",
]);
const DEFAULT_DELEGATION_POLICY = Object.freeze({ maxRepairs: 2, deadlineMs: 30 * 60 * 1000 });

function normalizeDelegationContract(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("委托合同必须是对象。");
  const goal = requiredText(value.goal, "目标", 12000);
  const workflowId = value.workflowId || "software_delivery";
  if (workflowId !== "software_delivery") throw new Error("第一阶段仅支持软件交付流程。");
  const deliverables = textList(value.deliverables, "交付物");
  const acceptanceCriteria = textList(value.acceptanceCriteria, "验收条件");
  if (!Array.isArray(value.subtasks) || !value.subtasks.length || value.subtasks.length > 30) {
    throw new Error("请提供 1 至 30 个分任务。");
  }
  const ids = new Set();
  const subtasks = value.subtasks.map((item) => {
    const id = requiredText(item?.id, "分任务 id", 80);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id))
      throw new Error("分任务 id 必须唯一且仅含字母、数字、下划线或连字符。");
    ids.add(id);
    return {
      id,
      title: requiredText(item.title, "分任务标题", 200),
      description: requiredText(item.description || item.title, "分任务说明", 4000),
    };
  });
  return { workflowId, goal, deliverables, acceptanceCriteria, subtasks };
}

function requiredText(value, label, limit) {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new Error(label + "为空或过长。");
  return value.trim();
}
function textList(value, label) {
  if (!Array.isArray(value) || !value.length || value.length > 30)
    throw new Error(label + "必须有 1 至 30 项。");
  return value.map((item) => requiredText(item, label, 2000));
}

module.exports = {
  DELEGATION_STATES,
  SOFTWARE_DUTIES,
  DEFAULT_DELEGATION_POLICY,
  normalizeDelegationContract,
};

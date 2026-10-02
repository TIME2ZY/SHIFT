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
const NODE_STATES = Object.freeze(["pending", "running", "completed", "failed", "cancelled"]);
const DEFAULT_DELEGATION_POLICY = Object.freeze({ maxRepairs: 2, deadlineMs: 30 * 60 * 1000 });

function normalizeDelegationContract(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("计划必须是对象。");
  const goal = requiredText(value.goal, "目标", 12000);
  const deliverables = textList(value.deliverables, "交付物");
  const acceptanceCriteria = textList(value.acceptanceCriteria, "验收条件");
  if (!Array.isArray(value.subtasks) || !value.subtasks.length || value.subtasks.length > 30)
    throw new Error("请提供 1 至 30 个分任务。");
  const ids = new Set();
  const subtasks = value.subtasks.map((item) => {
    const id = requiredText(item?.id, "分任务 id", 80);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id))
      throw new Error("分任务 id 必须唯一且仅含字母、数字、下划线或连字符。");
    ids.add(id);
    const dependsOn = item.dependsOn === undefined ? [] : textList(item.dependsOn, "依赖", true);
    return {
      id,
      title: requiredText(item.title, "分任务标题", 200),
      description: requiredText(item.description || item.title, "分任务说明", 4000),
      workflowId: requiredText(item.workflowId, "团队流程", 80),
      capabilities: textList(item.capabilities, "所需能力"),
      dependsOn,
      deliverables: textList(item.deliverables, "分任务交付物"),
      acceptanceCriteria: textList(item.acceptanceCriteria, "分任务验收条件"),
    };
  });
  const byId = new Map(subtasks.map((node) => [node.id, node]));
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error("分任务依赖存在环。");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id).dependsOn) {
      if (!ids.has(dep)) throw new Error("分任务依赖不存在：" + dep);
      visit(dep);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of ids) visit(id);
  for (const criterion of acceptanceCriteria)
    if (!subtasks.some((node) => node.acceptanceCriteria.includes(criterion)))
      throw new Error("总体验收条件必须分配给分任务：" + criterion);
  for (const deliverable of deliverables)
    if (!subtasks.some((node) => node.deliverables.includes(deliverable)))
      throw new Error("总体交付物必须分配给分任务：" + deliverable);
  return { goal, deliverables, acceptanceCriteria, subtasks };
}
function requiredText(value, label, limit) {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new Error(label + "为空或过长。");
  return value.trim();
}
function textList(value, label, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > 30)
    throw new Error(label + "项数无效。");
  return [...new Set(value.map((item) => requiredText(item, label, 2000)))];
}
module.exports = {
  DELEGATION_STATES,
  NODE_STATES,
  DEFAULT_DELEGATION_POLICY,
  normalizeDelegationContract,
};

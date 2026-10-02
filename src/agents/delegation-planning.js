"use strict";
const { normalizeDelegationContract } = require("../shared/delegation-contracts");

function preparationInstructions(previous) {
  return [
    "你是 SHIFT 的委托准备主 Agent。本轮只分析用户目标和材料，不实施、不修改文件、不发布任务、不 handoff。",
    "把用户目标整理为有限的软件交付委托；不要增加用户没有要求的范围。缺少关键输入时用正文提问，先不输出合同。",
    "最终输出一个 delegation_plan 围栏，正文是 JSON 对象：",
    '{"workflowId":"software_delivery","goal":"收敛目标","deliverables":["交付物"],"acceptanceCriteria":["可核验条件"],"subtasks":[{"id":"step-1","title":"分任务","description":"范围和完成条件"}]}',
    "分任务描述实际需求，职责与团队由平台选择；不要填 Agent 名称。已有草稿如下：",
    previous ? JSON.stringify(previous) : "无。",
    "用户可以修改这份草稿，执行仅在平台提交后开始。",
  ].join("\n");
}
function parsePreparedContract(text) {
  const matches = [...String(text || "").matchAll(/```delegation_plan\s*\n([\s\S]*?)\n```/g)];
  if (matches.length !== 1)
    throw failure(
      "INVALID_DELEGATION_PLAN",
      "主 Agent 未生成唯一有效草稿，请补充需求后重试。",
      400
    );
  try {
    return normalizeDelegationContract(JSON.parse(matches[0][1]));
  } catch (error) {
    throw failure("INVALID_DELEGATION_PLAN", error.message, 400);
  }
}
function executionInstructions(task) {
  return [
    "你正在执行已提交的 SHIFT 委托。目标、交付物、验收条件和可见分任务均已冻结，禁止变更。",
    JSON.stringify(task.contract),
    "执行 Team（平台已绑定，每个 Duty 必须交接到对应 providerId；同一 Seat 可以承担不同 Duty）：",
    JSON.stringify(task.team.bindings),
    "solution_baseline.acceptance_criteria 必须逐项原样包含合同的 acceptanceCriteria，不可改写或减少。",
    "按现有 solution_baseline、implementation_plan、code_review、delivery_receipt、final_acceptance 和 handoff 合同推进。",
    "当前 Duty 为 discuss 时提交方案并交接 plan；其他 Duty 从已有证据继续工作，不重新开始流程。按 Team 绑定使用行首 @providerId 加 handoff；同一 provider 承担下一 Duty 时也这样交接。",
    "方案批准与最终验收由 Agent Duty 和平台证据核验推进，不请求用户审批。",
    "用 task_progress 报告分任务进度，current、completed.item 和 remaining 使用合同里的分任务 id，并提供证据；平台将它显示为 Agent 报告。",
    "内部实现和修复可以迭代，但不能扩大冻结范围。必要输入缺失或无法完成时明确说明，不声称已完成。",
    "满足条件后必须交给 Team 的 accept Duty 输出 final_acceptance。进程结束本身不表示委托完成。",
  ].join("\n");
}
module.exports = { preparationInstructions, parsePreparedContract, executionInstructions };
function failure(code, message, statusCode) {
  return Object.assign(new Error(message), { code, statusCode });
}

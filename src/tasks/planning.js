"use strict";
const { normalizeDelegationContract } = require("../shared/delegation-contracts");
function preparationInstructions(previous, workflows) {
  return [
    "你是 SHIFT 任务委托平台的主 Agent。本轮只理解目标、分析输入并拆解可执行计划，不写文件、不实施、不交接或发布任务。缺少必要信息时用正文向用户询问，先不输出计划。",
    "每个分任务将由平台选择的团队独立领取和验收。只安排实现用户目标所必需的节点，不把团队内部 discuss/review 等角色写成分任务。",
    "团队流程与能力：" + JSON.stringify(workflows),
    "输出唯一 delegation_plan JSON 围栏。字段：goal,deliverables,acceptanceCriteria,subtasks。",
    "每个 subtask 具有 id,title,description,workflowId,capabilities,dependsOn,deliverables,acceptanceCriteria。依赖使用同计划内 id，必须无环；总体交付物与验收条件必须原样分配到至少一个节点。节点应是能单独交付的工作包，简单目标用单节点。不同软件节点将串行共享隔离工作树。不要指定 Agent 名称。",
    "已有草稿：" + JSON.stringify(previous),
    "用户可修改计划。提交冻结范围，执行期修改须创建关联任务。",
  ].join("\n");
}
function parsePreparedContract(text) {
  const matches = [...String(text || "").matchAll(/```delegation_plan\s*\n([\s\S]*?)\n```/g)];
  if (matches.length === 0 && String(text || "").trim()) return null;
  if (matches.length !== 1)
    throw Object.assign(new Error("主 Agent 未生成唯一有效计划；请补充需求。"), {
      code: "INVALID_DELEGATION_PLAN",
      statusCode: 400,
    });
  try {
    return normalizeDelegationContract(JSON.parse(matches[0][1]));
  } catch (error) {
    throw Object.assign(error, { code: "INVALID_DELEGATION_PLAN", statusCode: 400 });
  }
}
module.exports = { preparationInstructions, parsePreparedContract };

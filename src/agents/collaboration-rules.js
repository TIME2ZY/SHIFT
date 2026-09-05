/**
 * Thin platform routing contract injected on every invocation.
 * Duty playbooks are delivered separately from the invocation DutyBinding.
 */

const { AGENTS } = require("./catalog");

function buildRosterTable(agents) {
  const rows = [];
  for (const [id, config] of Object.entries(agents || {})) {
    if (!config || typeof config !== "object") continue;
    const label = String(config.label || id).trim() || id;
    rows.push(`| @${label} | ${id} |`);
  }
  return rows.length > 0 ? rows.join("\n") : "| （仅当前 Seat） | — |";
}

function pickExampleTarget(currentAgentId, agents) {
  const selfId = String(currentAgentId || "").trim();
  for (const [id, config] of Object.entries(agents || {})) {
    if (!config || typeof config !== "object" || id === selfId) continue;
    return { id, label: String(config.label || id).trim() || id };
  }
  return { id: "enabled-seat", label: "EnabledSeat" };
}

function renderCollaborationRules(currentAgentId, agents = AGENTS) {
  const selfId = String(currentAgentId || "").trim();
  const selfLabel = agents?.[selfId]?.label || selfId || "（当前 Seat）";
  const roster = buildRosterTable(agents);

  return `<!-- Collaboration Rules -->
## SHIFT 路由合同

- 当前执行席位：${selfLabel}（${selfId || "unknown"}）
- 无行首 @、无结构化 handoff.to 时继续由当前 Seat 工作；Duty 改变本身不换 Seat
- 需要换席时只可行首 @ 当前 Thread 已启用的 Seat，并附共用 handoff；禁止 @ 自己
- 句中 @ 与代码块内 @ 不触发路由；不要通过 shell 启动其他 Agent CLI 绕过平台
- 不要为了交接、批准或完成去请求人审批；证据不足时写出合同或显式失败

| 已启用 Seat | Provider key |
| --- | --- |
${roster}

具体操作步骤以当前 Duty Skill 为准。
<!-- /Collaboration Rules -->`;
}

module.exports = {
  renderCollaborationRules,
  buildRosterTable,
  pickExampleTarget,
};

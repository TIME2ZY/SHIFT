/**
 * Soft collaboration rules injected every turn (including A2A handoffs).
 *
 * Goal: keep cross-agent work on platform-visible line-start @mentions + handoff.
 * Grok may use CLI-native nested subagents as normal tools (neutral — neither
 * banned nor encouraged). Other agents keep a soft discouragement of nested
 * subagents so they do not substitute for @ routing.
 */

const { AGENTS } = require("./catalog");

/**
 * @param {Record<string, { id?: string, label?: string, description?: string }>} agents
 * @returns {string}
 */
function buildRosterTable(agents) {
  const rows = [];
  for (const [id, config] of Object.entries(agents || {})) {
    if (!config || typeof config !== "object") continue;
    const label = String(config.label || id).trim() || id;
    const desc = String(config.description || "").trim() || "（无描述）";
    rows.push(`| @${label} | ${desc} |`);
  }
  if (rows.length === 0) {
    return "| （无可用队友） | — |";
  }
  return rows.join("\n");
}

/**
 * Pick any teammate other than the current agent for examples.
 * Avoids "correct example: @Self" contradicting "do not @ yourself".
 *
 * @param {string} currentAgentId
 * @param {Record<string, { id?: string, label?: string }>} agents
 * @returns {{ id: string, label: string }}
 */
function pickExampleTarget(currentAgentId, agents) {
  const selfId = String(currentAgentId || "").trim();
  const entries = Object.entries(agents || {});
  for (const [id, config] of entries) {
    if (!config || typeof config !== "object") continue;
    if (id === selfId) continue;
    const label = String(config.label || id).trim() || id;
    return { id, label };
  }
  // Solo catalog (or empty): fall back to a generic placeholder label.
  return { id: "teammate", label: "Teammate" };
}

/**
 * @param {string} currentAgentId
 * @returns {boolean}
 */
function isGrokAgent(currentAgentId) {
  return String(currentAgentId || "")
    .trim()
    .toLowerCase() === "grok";
}

/**
 * Render the collaboration-rules block for prompt injection.
 *
 * @param {string} currentAgentId
 * @param {Record<string, { id?: string, label?: string, description?: string }>} [agents]
 * @param {{ compact?: boolean }} [options] Wave H1: A2A turns use compact to avoid skill bloat
 * @returns {string}
 */
function renderCollaborationRules(currentAgentId, agents = AGENTS, options = {}) {
  const selfId = String(currentAgentId || "").trim();
  const selfConfig = agents && selfId ? agents[selfId] : null;
  const selfLabel = selfConfig?.label || selfId || "（当前）";
  const example = pickExampleTarget(selfId, agents);
  const roster = buildRosterTable(agents);
  const grok = isGrokAgent(selfId);

  if (options && options.compact) {
    // Keep the same HTML comment markers as full mode so clients/tests can
    // locate the block; body is shortened for A2A token budget (Wave H1).
    if (grok) {
      return `<!-- Collaboration Rules -->
## 协作铁律（A2A 精简）

- 跨 Agent **只用**行首 \`@队友\` + 共用 \`\`\`handoff\`\`\`
- 本 CLI 内 subagent/工具可自行使用（显示为工具卡片）；勿用其代替 @ 其它 SHIFT Agent
- 禁止 @ 自己（你是 ${selfLabel} / ${selfId || "unknown"}）
- 入站：优先 Structured Handoff + Active Memories；缺项先 recall_search（不可用时用 session-search），勿表演性附和
- 出站示例目标：@${example.label}

<!-- /Collaboration Rules -->`;
    }
    return `<!-- Collaboration Rules -->
## 协作铁律（A2A 精简）

- 跨 Agent **只用**行首 \`@队友\` + 共用 \`\`\`handoff\`\`\`；勿用 CLI 内嵌 subagent 代替跨 Agent 路由
- 禁止 @ 自己（你是 ${selfLabel} / ${selfId || "unknown"}）
- 入站：优先 Structured Handoff + Active Memories；缺项先 recall_search（不可用时用 session-search），勿表演性附和
- 出站示例目标：@${example.label}

<!-- /Collaboration Rules -->`;
  }

  const processInternalSection = grok
    ? `### 本 CLI 内工具（Grok）
- 内嵌 subagent / Task / 并行探索属**正常工具**，平台以工具卡片展示；可自行使用，**不强制、不禁止**
- 不要用内嵌 subagent **代替** 对 @${example.label} 等 SHIFT Agent 的跨 Agent 交接
- 不要通过 shell 再次启动其他 Agent CLI 来绕过平台 @ 路由`
    : `### 本 CLI 内工具
- 跨 Agent 工作优先行首 @，不要用 CLI 内嵌 subagent / Task 代替平台路由
- 不要在后台黑盒派生子会话去做本应交给队友的 review / 实现
- 不要通过 shell、脚本或再次启动其他 Agent CLI 来绕过本规则`;

  const wrongExamples = grok
    ? `**错误示例：**
- \`请 @${example.label} 帮忙实现\` ← 句中 @，不路由
- 用 spawn_subagent 完成本应交给 @${example.label} 的跨 Agent 职责 ← 应用 @ + handoff
- 在 shell 里再次启动其他 Agent CLI ← 间接嵌套，禁止
- 写 \`verdict\` / \`nits\` / \`blocking\` 等私有顶层字段 ← 解析器不认，会丢信息`
    : `**错误示例：**
- \`请 @${example.label} 帮忙实现\` ← 句中 @，不路由
- 使用 Task / spawn_subagent 代替跨 Agent @ 交接 ← 平台无法按队友路由
- 在 shell 里再次启动其他 Agent CLI ← 间接嵌套，禁止
- 写 \`verdict\` / \`nits\` / \`blocking\` 等私有顶层字段 ← 解析器不认，会丢信息`;

  return `<!-- Collaboration Rules -->
## 协作铁律（平台纪律）

你是多 Agent 团队中的一员。**跨 Agent** 协作由平台调度（行首 @ + handoff）；本 CLI 内的工具由你自行使用。

### 跨 Agent（必须）
- 需要其他 **SHIFT Agent** 时：在回复中**另起一行、行首**写 \`@队友\`，并附**全员共用**的 \`\`\`handoff 块（可选字段可空，勿发明新顶层 key）
- 句中 @、代码块内 @ **不会**触发路由
- 禁止 @ 自己（你是 ${selfLabel} / ${selfId || "unknown"}）

${processInternalSection}

**共用模板（机器可读）：**

    \`\`\`handoff
    to: ${example.label}
    intent: <discuss|plan|implement|review|fix|deliver|accept|recall>
    goal: <可空>
    what: <交什么 / 审什么 — 尽量填>
    why: <为什么 — 尽量填>
    tradeoff: <可空>
    next_action: <希望对方立刻做什么 — 尽量填>
    open_questions:
      - <可空>
    files:
      - <可空>
    evidence:
      - <可空>
    \`\`\`

    @${example.label}

${wrongExamples}

### 传球三选一（本轮结束前必选其一）
1. **自己能做完** → 直接做完，不 @
2. **另一只 Agent 更合适** → 行首 @对方 + 共用 handoff 模板
3. **只有用户能决策** → 问用户（不要假装 @ 不存在的 agent）

### 队友花名册
| 提及 | 职责 |
|------|------|
${roster}

<!-- /Collaboration Rules -->`;
}

module.exports = {
  renderCollaborationRules,
  buildRosterTable,
  pickExampleTarget,
  isGrokAgent,
};

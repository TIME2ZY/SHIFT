/**
 * Serial multi-agent collab scenario: discuss (Gemini↔Codex) then implement (Grok↔OpenCode).
 * Capacities are applied by the runner per phase (discuss 22K / implement 48K).
 */

const SCENARIO_ID = "multi-auth-collab";
const TITLE = "Live · 多 Agent 串行协作（讨论→实现）";

/** @type {import('../lib/multi-types').PhaseDef[]} */
const PHASES = [
  {
    id: "discuss",
    label: "讨论环 Gemini↔Codex",
    capacity: 22_000,
    useWorktree: false,
    allowedAgents: ["gemini", "codex"],
    minUserTurns: 4,
    // Do not stop the whole run on first seal; phase ends after scripted turns.
    turns: [
      {
        id: "d1_diverge",
        agent: "gemini",
        prompt: [
          "我们要给这个本地控制台加登录/鉴权。先别改仓库。",
          "请 @Gemini 从实现视角发散 3～5 种可行形态（纯 JWT、服务端 session、混合等），",
          "每种写清适用场景、落地成本、和多实例/本机优先的关系；尽量写细，方便后续收敛。",
          "若需要收敛，行首 @Codex 并附 ```handoff。",
        ].join(""),
      },
      {
        id: "d2_converge",
        agent: "codex",
        prompt: [
          "请 @Codex 基于上文方案做收敛：比较取舍，给出更稳妥的推荐方向。",
          "产品约束：登录态大约保持一周；本期不做 refresh token；密码哈希用现代慢哈希。",
          "若结论可复用，请用结构化记忆写下稳定 topic（优先 auth-token-ttl / auth-no-refresh / auth-password-hash）。",
          "需要再发散时行首 @Gemini + handoff。",
        ].join(""),
      },
      {
        id: "d3_threat",
        agent: "gemini",
        prompt: [
          "请 @Gemini 针对当前收敛方向补一版威胁模型与风险清单（暴力破解、吊销、多设备、日志脱敏等），",
          "标 P0/P1，尽量写完整。完成后行首 @Codex 请其拍板。",
        ].join(""),
      },
      {
        id: "d4_decide",
        agent: "codex",
        prompt: [
          "请 @Codex 综合威胁模型拍板：token/会话策略、是否 JWT、存储（SQLite）、本地端口 8787。",
          "稳定结论写入记忆（canonical topic：auth-token-ttl、auth-no-refresh、storage-primary、local-dev-port 等）。",
          "本幕结束后将交给实现；若还要补一句交接给实现，可准备 @Grok 的 handoff 字段草稿（本轮仍可不 @Grok）。",
        ].join(""),
      },
    ],
  },
  {
    id: "implement",
    label: "实现环 Grok↔OpenCode（改代码）",
    capacity: 48_000,
    useWorktree: true,
    allowedAgents: ["grok", "opencode"],
    minUserTurns: 4,
    turns: [
      {
        id: "i1_implement",
        agent: "grok",
        prompt: [
          "改代码已开启（worktree）。请 @Grok 按本会话已定约束实现登录鉴权最小闭环：",
          "用户模型/迁移、POST /api/login、鉴权中间件与现有 UI token/Host 门禁的关系、基础测试。",
          "遵守：TTL/无 refresh/SQLite/端口等记忆中的结论；不要另起一套方案。",
          "完成后行首 @OpenCode 并附完整 ```handoff（what/why/next_action/files/evidence）。",
        ].join(""),
      },
      {
        id: "i2_review",
        agent: "opencode",
        prompt: [
          "请 @OpenCode 审查刚完成的登录相关改动：安全、错误处理、与约束一致性、测试缺口。",
          "结论写进 handoff 的 what（结论: request-changes 或 approve / approve-with-nits）。",
          "若需回修，行首 @Grok；若可放行则不要 @。",
        ].join(""),
      },
      {
        id: "i3_fix",
        agent: "grok",
        prompt: [
          "请 @Grok 根据 OpenCode 的 review 处理：有 P0 则修并补测；若已 approve 则确认 diff 与验证命令。",
          "修完后如需再审，行首 @OpenCode + handoff。",
        ].join(""),
      },
      {
        id: "i4_reconfirm",
        agent: "opencode",
        prompt: [
          "请 @OpenCode 做最终确认：是否可合入、剩余风险、是否还需要用户操作。",
          "approve 则不要 @；仍有阻塞则 @Grok。",
        ].join(""),
      },
    ],
  },
  {
    id: "recall",
    label: "回顾",
    capacity: 48_000,
    useWorktree: false,
    allowedAgents: ["codex", "grok"],
    minUserTurns: 1,
    turns: [
      {
        id: "r1_recall",
        agent: "codex",
        prompt: [
          "请基于本 thread 的记忆与交接，总结：token/会话策略、存储、端口、是否 refresh、实现与 review 现状。",
          "不确定处用 session-search，不要另起新方案。",
        ].join(""),
      },
    ],
  },
];

module.exports = {
  SCENARIO_ID,
  TITLE,
  PHASES,
  REQUIRED_CLIS: ["gemini", "codex", "grok", "opencode"],
};

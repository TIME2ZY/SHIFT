/**
 * Real multi-turn user prompts for solo Grok live scenario.
 * Agent replies are never scripted — only the human side is fixed.
 *
 * Background: add login/auth to the local console; discuss then specify,
 * without forcing the model to "remember a token string".
 */

const SCENARIO_ID = "solo-grok-auth";
const TITLE = "Live · Grok 登录鉴权多轮";

/** Stack turns that build constraints and (hopefully) context until seal. */
const STACK_TURNS = [
  {
    id: "u1_explore",
    prompt: [
      "我们要给这个控制台加登录能力。",
      "先别改仓库、先别开 worktree。",
      "请用实现视角帮我比较三种做法：纯 JWT、服务端 session、两者混合。",
      "各自适合什么场景、落地成本差在哪、和多实例/本机优先有什么关系。",
    ].join(""),
  },
  {
    id: "u2_constraints",
    prompt: [
      "产品侧希望登录态大概保持一周；这期明确不做 refresh token。",
      "密码哈希不要用过时方案。",
      "把后续实现也要遵守的稳定结论整理出来；",
      "如果适合写成结构化记忆（decision / constraint），请用平台支持的方式留下，topic 起稳一点。",
    ].join(""),
  },
  {
    id: "u3_storage",
    prompt: [
      "在线数据读写就定 SQLite，不要两套源。",
      "本地开发端口先按 8787。",
      "同样，稳定结论请留下，方便后面实现还记得住。",
    ].join(""),
  },
  {
    id: "u4_revise_ttl",
    prompt: [
      "运营反馈一周太长了：访问 token 改成 24 小时。",
      "其它约束（不做 refresh、SQLite、端口）不变。",
      "请更新约定，不要和旧的「一周」结论并存成两套真理。",
    ].join(""),
  },
  {
    id: "u5_api_spec",
    prompt: [
      "请把 POST /api/login 写成实现规格级说明：",
      "请求/响应 JSON 形状、密码错误、用户不存在、限流等错误码与 body。",
      "尽量写完整，方便后面直接照着实现和写测试。",
    ].join(""),
  },
  {
    id: "u6_logout",
    prompt: [
      "在无 refresh、仅 JWT 的前提下，logout 与吊销怎么做？",
      "写清能力边界、建议测哪些用例、以及做不到什么（避免实现时过度承诺）。",
    ].join(""),
  },
  {
    id: "u7_impl_order",
    prompt: [
      "列一下实现顺序：库表/迁移 → 路由 → 鉴权中间件 → 测试。",
      "每步给一句话验收标准，以及你建议动到的关键文件路径。",
      "这轮仍然先别改仓库。",
    ].join(""),
  },
  {
    id: "u8_test_table",
    prompt: [
      "针对你刚列的顺序，把测试用例表写细一些：",
      "用例名、前置条件、步骤、期望状态码和 body 要点。",
      "覆盖成功登录、错误密码、限流、未授权访问受保护路由。",
    ].join(""),
  },
  {
    id: "u9_security",
    prompt: [
      "安全清单请逐项给实现注意点：",
      "暴力破解防护、密码校验时序、日志脱敏、JWT 声明最小集、密钥从哪来。",
      "标出哪些是 P0 必须做、哪些可以二期。",
    ].join(""),
  },
  {
    id: "u10_middleware",
    prompt: [
      "把鉴权中间件的处理流程写成伪代码级说明（仍不要真改仓库）：",
      "如何取 token、校验失败怎么返回、成功后上下文里挂什么字段。",
      "并说明和登录路由如何配合。",
    ].join(""),
  },
  {
    id: "u11_edge_cases",
    prompt: [
      "补充边界情况：时钟偏移、token 快过期、并发登录同一账号、",
      "改密后旧 token 是否仍可用。对每项给出当前阶段的推荐策略和理由。",
    ].join(""),
  },
  {
    id: "u12_checklist",
    prompt: [
      "把到目前为止的约定收成一份「实现前检查清单」：",
      "必须遵守的决策、约束、事实（端口等）、以及明确不做的事。",
      "条目要短，便于开干前扫一眼。",
    ].join(""),
  },
];

/** Asked after stack turns (and after seal if it happened mid-stack). */
const RECALL_TURN = {
  id: "ur_recall",
  prompt: [
    "我们现在定的 token 策略和存储方案分别是什么？",
    "实现时有哪些硬约束必须遵守？",
    "请基于当前会话里已经确认或留下的约定来回答，不要另起一套新方案。",
  ].join(""),
};

module.exports = {
  SCENARIO_ID,
  TITLE,
  AGENT: "grok",
  STACK_TURNS,
  RECALL_TURN,
};

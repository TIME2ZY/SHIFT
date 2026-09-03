"use strict";

const crypto = require("node:crypto");
const { ENV } = require("../shared/brand");

const IMPLEMENTATION_GATE_STATUS = Object.freeze({
  REQUIRED: "required",
  PENDING_APPROVAL: "pending_approval",
  APPROVED: "approved",
});

const REQUIRED_PLAN_FIELDS = Object.freeze(["summary", "files", "changes", "tests"]);
const PLAN_LIST_FIELDS = new Set(["files", "changes", "tests", "risks"]);

function parseImplementationPlan(text) {
  const blocks = [];
  const re = /```implementation_plan\s*\r?\n([\s\S]*?)```/gi;
  let match;
  while ((match = re.exec(String(text || ""))) !== null) {
    const plan = parseImplementationPlanBody(match[1]);
    if (plan) blocks.push(plan);
  }
  return blocks.length > 0 ? blocks[blocks.length - 1] : null;
}

function parseImplementationPlanBody(body) {
  const plan = { summary: "", files: [], changes: [], tests: [], risks: [] };
  let currentList = null;

  for (const rawLine of String(body || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (line.startsWith("- ") && currentList) {
      const value = cleanPlanValue(line.slice(2));
      if (value) plan[currentList].push(value);
      continue;
    }

    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = cleanPlanValue(line.slice(colon + 1));
    if (key === "summary") {
      plan.summary = value;
      currentList = null;
      continue;
    }
    if (PLAN_LIST_FIELDS.has(key)) {
      currentList = key;
      if (value) plan[key].push(value);
      continue;
    }
    currentList = null;
  }

  return validateImplementationPlan(plan).ok ? plan : null;
}

function cleanPlanValue(value) {
  const text = String(value || "").trim();
  if (!text || /^<[^>]+>$/.test(text)) return "";
  return text.replace(/^(["'])|(["'])$/g, "");
}

function validateImplementationPlan(plan) {
  const missing = [];
  if (!plan || typeof plan !== "object") {
    return { ok: false, missing: REQUIRED_PLAN_FIELDS.slice() };
  }
  if (!String(plan.summary || "").trim()) missing.push("summary");
  for (const field of REQUIRED_PLAN_FIELDS.slice(1)) {
    if (!Array.isArray(plan[field]) || plan[field].length === 0) missing.push(field);
  }
  return { ok: missing.length === 0, missing };
}

function hashImplementationPlan(plan) {
  const validation = validateImplementationPlan(plan);
  if (!validation.ok) {
    throw new Error(`Invalid implementation plan; missing: ${validation.missing.join(", ")}`);
  }
  const canonical = JSON.stringify({
    summary: String(plan.summary).trim(),
    files: plan.files.map(normalizeListValue),
    changes: plan.changes.map(normalizeListValue),
    tests: plan.tests.map(normalizeListValue),
    risks: Array.isArray(plan.risks) ? plan.risks.map(normalizeListValue) : [],
  });
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function normalizeListValue(value) {
  return String(value || "").trim();
}

function isImplementationApproved(gate) {
  const planHash = String(gate?.planHash || "");
  return Boolean(
    gate?.status === IMPLEMENTATION_GATE_STATUS.APPROVED &&
    planHash &&
    String(gate?.approvedPlanHash || "") === planHash
  );
}

function resolveImplementationGateEnv(env = process.env) {
  const status = String(env[ENV.IMPLEMENTATION_GATE] || "")
    .trim()
    .toLowerCase();
  const planHash = String(env[ENV.APPROVED_PLAN_HASH] || "").trim();
  const allowed = status === IMPLEMENTATION_GATE_STATUS.APPROVED && Boolean(planHash);
  return {
    allowed,
    status: allowed
      ? IMPLEMENTATION_GATE_STATUS.APPROVED
      : status || IMPLEMENTATION_GATE_STATUS.REQUIRED,
    planHash: allowed ? planHash : null,
    reason: allowed ? null : "implementation_plan_not_approved",
  };
}

function renderImplementationGateBlock(gate) {
  if (!gate) return "";
  const approved = isImplementationApproved(gate);
  const planHash = String(gate.planHash || "");
  const lines = ["<!-- Implementation Gate -->", "## 实现门禁（平台强制）", ""];

  if (approved) {
    lines.push(
      `状态：APPROVED（plan hash: \`${planHash}\`）`,
      "你现在可以修改文件和执行实现所需命令，但不得偏离已批准方案。",
      "完成后必须总结改动、验证和未解决项，再以 `review` intent 交给可用 Seat。"
    );
  } else {
    lines.push(
      `状态：${gate.status || IMPLEMENTATION_GATE_STATUS.REQUIRED}（只读）`,
      "平台会拒绝 edit / delete / move / execute；即使已开启 worktree 也不能写入。",
      "本轮只读取与搜索代码，然后输出一个完整的 `implementation_plan` 块。",
      "",
      "```implementation_plan",
      "summary: <方案摘要>",
      "files:",
      "  - <预计修改的文件>",
      "changes:",
      "  - <逐项具体改法>",
      "tests:",
      "  - <验证命令或测试范围>",
      "risks:",
      "  - <风险或边界，可空>",
      "```",
      "",
      "方案提交后以 `discuss` intent 请求批准。只有具备批准 Duty 的参与者对该 plan hash 发出显式 `implement` 交接，平台才会开放写权限。"
    );
  }
  lines.push("<!-- /Implementation Gate -->");
  return lines.join("\n");
}

module.exports = {
  IMPLEMENTATION_GATE_STATUS,
  REQUIRED_PLAN_FIELDS,
  parseImplementationPlan,
  parseImplementationPlanBody,
  validateImplementationPlan,
  hashImplementationPlan,
  isImplementationApproved,
  resolveImplementationGateEnv,
  renderImplementationGateBlock,
};

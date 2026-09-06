"use strict";

const crypto = require("node:crypto");

const COMMIT_SUBJECT_RE =
  /^(feat|fix|refactor|perf|test|docs|build|ci|chore|revert)(\([a-z0-9._/-]+\))?!?: [^\r\n]+$/;
const SAFE_BRANCH_RE = /^(?![./])(?!.*(?:\.\.|@\{|\\|\s|[~^:?*[]))(?!.*\/$).+$/;
const REQUIRED_PR_SECTIONS = Object.freeze([
  { key: "intent", heading: "## 意图" },
  { key: "main_flow_impact", heading: "## 主链路影响" },
  { key: "path_changes", heading: "## 路径变化（公开入口 / 双写）" },
  { key: "tests", heading: "## 测试（旧接口测试是否处理）" },
  { key: "risks_and_rollback", heading: "## 风险与回滚" },
]);

function parseSolutionBaseline(text) {
  const value = parseStructuredBlock(text, "solution_baseline", {
    scalars: ["user_goal_hash", "summary"],
    lists: ["constraints", "non_goals", "acceptance_criteria"],
  });
  return validateSolutionBaseline(value).ok ? value : null;
}

function validateSolutionBaseline(value) {
  const missing = [];
  if (!value || typeof value !== "object") {
    return {
      ok: false,
      missing: ["user_goal_hash", "summary", "constraints", "non_goals", "acceptance_criteria"],
    };
  }
  if (!isShortHash(value.user_goal_hash)) missing.push("user_goal_hash");
  if (!clean(value.summary)) missing.push("summary");
  for (const field of ["constraints", "non_goals", "acceptance_criteria"]) {
    if (!nonEmptyList(value[field])) missing.push(field);
  }
  return { ok: missing.length === 0, missing };
}

function hashSolutionBaseline(value) {
  const validation = validateSolutionBaseline(value);
  if (!validation.ok) {
    throw new Error(`Invalid solution baseline; missing: ${validation.missing.join(", ")}`);
  }
  return shortHash({
    userGoalHash: clean(value.user_goal_hash),
    summary: clean(value.summary),
    constraints: normalizeList(value.constraints),
    nonGoals: normalizeList(value.non_goals),
    acceptanceCriteria: normalizeList(value.acceptance_criteria),
  });
}

function parseCodeReview(text) {
  const value = parseStructuredBlock(text, "code_review", {
    scalars: ["verdict", "summary"],
    lists: ["findings", "tests"],
  });
  if (value) value.verdict = clean(value.verdict).toLowerCase().replace(/-/g, "_");
  return validateCodeReview(value).ok ? value : null;
}

function validateCodeReview(value) {
  const missing = [];
  if (!value || typeof value !== "object") {
    return { ok: false, missing: ["verdict", "summary", "findings", "tests"] };
  }
  if (!["approve", "changes_requested"].includes(value.verdict)) missing.push("verdict");
  if (!clean(value.summary)) missing.push("summary");
  if (!nonEmptyList(value.findings)) missing.push("findings");
  if (!nonEmptyList(value.tests)) missing.push("tests");
  return { ok: missing.length === 0, missing };
}

function hashCodeReview(value, commitSha) {
  const validation = validateCodeReview(value);
  if (!validation.ok) {
    throw new Error(`Invalid code review; missing: ${validation.missing.join(", ")}`);
  }
  return shortHash({
    verdict: value.verdict,
    summary: clean(value.summary),
    findings: normalizeList(value.findings),
    tests: normalizeList(value.tests),
    commitSha: clean(commitSha),
  });
}

function parseDeliveryReceipt(text) {
  const value = parseStructuredBlock(text, "delivery_receipt", {
    scalars: ["commit_sha", "pr_url", "base_branch"],
    lists: ["verification"],
  });
  return validateDeliveryReceipt(value).ok ? value : null;
}

function validateDeliveryReceipt(value) {
  const missing = [];
  if (!value || typeof value !== "object") {
    return { ok: false, missing: ["commit_sha", "pr_url", "base_branch", "verification"] };
  }
  if (!/^[a-f0-9]{40}$/i.test(clean(value.commit_sha))) missing.push("commit_sha");
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/?$/i.test(clean(value.pr_url))) {
    missing.push("pr_url");
  }
  if (!isSafeBranch(value.base_branch)) missing.push("base_branch");
  if (!nonEmptyList(value.verification)) missing.push("verification");
  return { ok: missing.length === 0, missing };
}

function validateVerifiedDelivery(evidence, receipt) {
  const reason = invalidVerifiedDeliveryReason(evidence, receipt);
  return { ok: !reason, reason };
}

function invalidVerifiedDeliveryReason(evidence, receipt) {
  if (!evidence || evidence.verified !== true) return evidence?.reason || "delivery_not_verified";
  if (clean(evidence.commitSha) !== clean(receipt?.commit_sha)) return "delivery_commit_mismatch";
  if (normalizeUrl(evidence.prUrl) !== normalizeUrl(receipt?.pr_url)) return "delivery_pr_mismatch";
  if (clean(evidence.baseBranch) !== clean(receipt?.base_branch)) return "delivery_base_mismatch";
  if (!validateCommitMessage(evidence.commitSubject, evidence.commitBody).ok) {
    return "delivery_commit_message_invalid";
  }
  if (!validatePullRequestDescription(evidence.prTitle, evidence.prBody).ok) {
    return "delivery_pr_description_invalid";
  }
  return null;
}

function validateCommitMessage(subject, body) {
  const normalizedSubject = clean(subject);
  const normalizedBody = clean(body);
  const reasons = [];
  if (!COMMIT_SUBJECT_RE.test(normalizedSubject)) reasons.push("subject_not_conventional");
  if (normalizedSubject.length > 72) reasons.push("subject_too_long");
  if (normalizedBody.length < 20) reasons.push("body_too_short");
  return { ok: reasons.length === 0, reasons };
}

function validatePullRequestDescription(title, body) {
  const normalizedTitle = clean(title);
  const normalizedBody = String(body || "").trim();
  const reasons = [];
  if (normalizedTitle.length < 10 || normalizedTitle.length > 100) reasons.push("title_length");
  for (const section of REQUIRED_PR_SECTIONS) {
    if (!normalizedBody.includes(section.heading)) reasons.push(`missing_${section.key}`);
  }
  if (!hasModelAttribution(normalizedBody)) reasons.push("missing_model_attribution");
  return { ok: reasons.length === 0, reasons };
}

function hasModelAttribution(body) {
  const lines = String(body || "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line) return /^来自\s+\S+/.test(line);
  }
  return false;
}

function parseFinalAcceptance(text) {
  const value = parseStructuredBlock(text, "final_acceptance", {
    scalars: [
      "verdict",
      "user_goal_hash",
      "solution_hash",
      "implementation_plan_hash",
      "commit_sha",
    ],
    lists: ["checks", "gaps"],
  });
  if (value) value.verdict = clean(value.verdict).toLowerCase();
  return validateFinalAcceptanceShape(value).ok ? value : null;
}

function validateFinalAcceptanceShape(value) {
  const missing = [];
  if (!value || typeof value !== "object") {
    return {
      ok: false,
      missing: [
        "verdict",
        "user_goal_hash",
        "solution_hash",
        "implementation_plan_hash",
        "commit_sha",
        "checks",
        "gaps",
      ],
    };
  }
  if (!["accept", "reject"].includes(value.verdict)) missing.push("verdict");
  for (const field of ["user_goal_hash", "solution_hash", "implementation_plan_hash"]) {
    if (!isShortHash(value[field])) missing.push(field);
  }
  if (!/^[a-f0-9]{40}$/i.test(clean(value.commit_sha))) missing.push("commit_sha");
  if (!nonEmptyList(value.checks)) missing.push("checks");
  if (!nonEmptyList(value.gaps)) missing.push("gaps");
  return { ok: missing.length === 0, missing };
}

function validateFinalAcceptanceAgainstTask(value, task) {
  const shape = validateFinalAcceptanceShape(value);
  if (!shape.ok) return { ok: false, reason: "invalid_final_acceptance" };
  const goal = task?.artifacts?.userGoal;
  const solution = task?.artifacts?.solutionBaseline;
  const implementation = task?.artifacts?.implementationPlan;
  const delivery = task?.deliveryGate;
  if (!goal?.hash || clean(value.user_goal_hash) !== clean(goal.hash)) {
    return { ok: false, reason: "final_user_goal_mismatch" };
  }
  if (!solution?.hash || clean(value.solution_hash) !== clean(solution.hash)) {
    return { ok: false, reason: "final_solution_mismatch" };
  }
  if (
    !implementation?.hash ||
    clean(value.implementation_plan_hash) !== clean(implementation.hash)
  ) {
    return { ok: false, reason: "final_implementation_plan_mismatch" };
  }
  if (!delivery?.commitSha || clean(value.commit_sha) !== clean(delivery.commitSha)) {
    return { ok: false, reason: "final_commit_mismatch" };
  }
  if (delivery.ciStatus !== "success") return { ok: false, reason: "ci_not_successful" };

  if (value.verdict === "accept") {
    const checks = normalizeList(value.checks);
    for (const criterion of solution.acceptance_criteria || []) {
      const needle = clean(criterion).toLowerCase();
      const matched = checks.some((check) => {
        const normalized = check.toLowerCase();
        return normalized.includes(needle) && /=>\s*pass\s*:/i.test(normalized);
      });
      if (!matched) return { ok: false, reason: "acceptance_criterion_not_passed" };
    }
    if (!onlyNoGaps(value.gaps)) return { ok: false, reason: "final_acceptance_has_gaps" };
  }
  return { ok: true, reason: null };
}

function hashUserGoal(text) {
  const value = clean(text);
  if (!value) throw new Error("User goal text is required");
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function renderOutcomeEvidenceBlock(dutyName, task, context = {}) {
  const duty = clean(dutyName).toLowerCase();
  if (["discuss", "plan", "accept"].includes(duty)) {
    return renderSolutionEvidenceBlock(task);
  }
  if (["review", "deliver"].includes(duty)) {
    return renderReviewDeliveryEvidenceBlock(task, context);
  }
  return "";
}

function renderSolutionEvidenceBlock(task) {
  const goal = task?.artifacts?.userGoal;
  const solution = task?.artifacts?.solutionBaseline;
  const implementation = task?.artifacts?.implementationPlan;
  const delivery = task?.deliveryGate;
  const lines = ["<!-- Outcome Evidence Gate -->", "## 目标证据门禁（平台强制）", ""];
  if (!solution) {
    lines.push(
      `最初用户目标 hash：\`${goal?.hash || "missing"}\`。进入实现计划前必须输出：`,
      "",
      "```solution_baseline",
      `user_goal_hash: ${goal?.hash || "<平台提供的用户目标 hash>"}`,
      "summary: <收敛后的可行方案>",
      "constraints:",
      "  - <必须遵守的约束；没有则写 none>",
      "non_goals:",
      "  - <明确不做的内容；没有则写 none>",
      "acceptance_criteria:",
      "  - <逐项可验证的验收标准>",
      "```",
      "",
      "缺失或 hash 不匹配时，平台拒绝 `plan` 交接。"
    );
  } else if (delivery) {
    lines.push(
      `最初用户目标 hash：\`${goal?.hash || "missing"}\``,
      `收敛方案 hash：\`${solution.hash}\``,
      `实现方案 hash：\`${implementation?.hash || "missing"}\``,
      `交付 commit：\`${delivery.commitSha || "missing"}\``,
      `PR：${delivery.prUrl || "missing"}；CI：${delivery.ciStatus || "unknown"}`,
      "",
      "最终验收必须逐项回到最初用户目标和收敛方案，而不是只判断代码是否合理：",
      "",
      "```final_acceptance",
      "verdict: <accept|reject>",
      `user_goal_hash: ${goal?.hash || "<hash>"}`,
      `solution_hash: ${solution.hash}`,
      `implementation_plan_hash: ${implementation?.hash || "<hash>"}`,
      `commit_sha: ${delivery.commitSha || "<40-char sha>"}`,
      "checks:"
    );
    for (const criterion of solution.acceptance_criteria || []) {
      lines.push(`  - ${criterion} => <pass|fail>: <证据>`);
    }
    lines.push(
      "gaps:",
      "  - <未满足项；全部满足时写 none>",
      "```",
      "",
      "只有所有标准都有 `=> pass: 证据`、无 gap、CI 成功且四个 hash 全部匹配，平台才进入 done。"
    );
  }
  lines.push("<!-- /Outcome Evidence Gate -->");
  return lines.join("\n");
}

function renderReviewDeliveryEvidenceBlock(task, context = {}) {
  const review = task?.codeReviewGate;
  const modelId = clean(context.modelId) || "<当前模型 ID>";
  const lines = [
    "<!-- Review Delivery Gate -->",
    "## Review 与交付门禁（平台强制）",
    "",
    "当前 Duty 负责代码 review 与交付。先 review；需要修改则以 `fix` intent 交回可用 Seat。只有 approve 后才执行交付。",
    "approve 时必须由你在当前 worktree 运行 `npm run verify:pr`，规范 commit、push、创建 ready PR，并等待 GitHub checks 成功。",
    "commit subject 必须使用 Conventional Commit 且不超过 72 字符；commit body 必须说明改动与原因。",
    "PR title 必须为 10–100 个字符；PR body 必须包含 `## 意图`、`## 主链路影响`、`## 路径变化（公开入口 / 双写）`、`## 测试（旧接口测试是否处理）`、`## 风险与回滚` 五节。",
    `PR body 五节之后，末尾另起一行写：来自 ${modelId}。写模型 ID，不要写厂家或 Seat 名。不要把它做成新的标题章节。`,
    `当前分支：\`${context.branch || "missing"}\`；当前 review gate：${review?.verdict || "pending"}。`,
    "",
    "最终输出必须包含两个 block：",
    "",
    "```code_review",
    "verdict: <approve|changes_requested>",
    "summary: <评审结论>",
    "findings:",
    "  - <P0/P1/P2 问题；无问题写 none>",
    "tests:",
    "  - <实际验证及结果>",
    "```",
    "",
    "approve 且完成真实交付后再输出：",
    "",
    "```delivery_receipt",
    "commit_sha: <40-char commit sha>",
    "pr_url: <https://github.com/.../pull/...>",
    "base_branch: <master|main|实际目标分支>",
    "verification:",
    "  - npm run verify:pr: passed",
    "  - GitHub checks: passed",
    "```",
    "",
    "平台会独立读取 Git 与 GitHub 验证以上内容；不能用文本声明代替真实 commit、PR 或 CI。",
    "<!-- /Review Delivery Gate -->",
  ];
  return lines.join("\n");
}

function parseStructuredBlock(text, fence, schema) {
  const safeFence = String(fence || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("```" + safeFence + "\\s*\\r?\\n([\\s\\S]*?)```", "gi");
  let parsed = null;
  let match;
  while ((match = re.exec(String(text || ""))) !== null) {
    parsed = parseBody(match[1], schema);
  }
  return parsed;
}

function parseBody(body, schema) {
  const scalarFields = new Set(schema.scalars || []);
  const listFields = new Set(schema.lists || []);
  const result = {};
  for (const field of scalarFields) result[field] = "";
  for (const field of listFields) result[field] = [];
  let currentList = null;

  for (const rawLine of String(body || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("- ") && currentList) {
      const value = cleanValue(line.slice(2));
      if (value) result[currentList].push(value);
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = cleanValue(line.slice(colon + 1));
    if (scalarFields.has(key)) {
      result[key] = value;
      currentList = null;
    } else if (listFields.has(key)) {
      currentList = key;
      if (value) result[key].push(value);
    } else {
      currentList = null;
    }
  }
  return result;
}

function cleanValue(value) {
  const text = clean(value);
  if (!text || /^<[^>]+>$/.test(text)) return "";
  return text.replace(/^(?:["'])|(?:["'])$/g, "");
}

function clean(value) {
  return String(value || "").trim();
}

function normalizeList(value) {
  return Array.isArray(value) ? value.map(clean).filter(Boolean) : [];
}

function nonEmptyList(value) {
  return normalizeList(value).length > 0;
}

function isShortHash(value) {
  return /^[a-f0-9]{16}$/i.test(clean(value));
}

function isSafeBranch(value) {
  return SAFE_BRANCH_RE.test(clean(value));
}

function shortHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function onlyNoGaps(gaps) {
  const values = normalizeList(gaps).map((value) => value.toLowerCase());
  return values.length === 1 && ["none", "无", "无未满足项"].includes(values[0]);
}

function normalizeUrl(value) {
  return clean(value).replace(/\/$/, "");
}

module.exports = {
  COMMIT_SUBJECT_RE,
  REQUIRED_PR_SECTIONS,
  parseSolutionBaseline,
  validateSolutionBaseline,
  hashSolutionBaseline,
  parseCodeReview,
  validateCodeReview,
  hashCodeReview,
  parseDeliveryReceipt,
  validateDeliveryReceipt,
  validateVerifiedDelivery,
  validateCommitMessage,
  validatePullRequestDescription,
  parseFinalAcceptance,
  validateFinalAcceptanceShape,
  validateFinalAcceptanceAgainstTask,
  hashUserGoal,
  renderOutcomeEvidenceBlock,
  isSafeBranch,
};

"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const {
  validateDeliveryReceipt,
  validateVerifiedDelivery,
} = require("../agents/workflow-gates");

const SUCCESSFUL_CHECK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

function createDeliveryVerifier(options = {}) {
  const commandRunner = options.commandRunner || spawnSync;

  function run(command, args, cwd, allowStatus = [0]) {
    const result = commandRunner(command, args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      timeout: Number(options.timeoutMs || 30_000),
    });
    const status = Number.isInteger(result?.status) ? result.status : result?.error ? -1 : 0;
    if (!allowStatus.includes(status)) {
      const message = String(result?.stderr || result?.stdout || result?.error?.message || "").trim();
      throw new Error(message || `${command} ${args.join(" ")} failed`);
    }
    return String(result?.stdout || "").trim();
  }

  function verify(input = {}) {
    const receipt = input.receipt;
    const receiptValidation = validateDeliveryReceipt(receipt);
    if (!receiptValidation.ok) {
      return { verified: false, reason: "invalid_delivery_receipt" };
    }
    const cwd = path.resolve(String(input.cwd || ""));
    const expectedBranch = String(input.branch || "").trim();
    if (!cwd || !expectedBranch) return { verified: false, reason: "managed_worktree_required" };

    try {
      const status = run("git", ["status", "--porcelain"], cwd);
      if (status) return { verified: false, reason: "delivery_worktree_dirty" };

      const branch = run("git", ["branch", "--show-current"], cwd);
      if (branch !== expectedBranch) {
        return { verified: false, reason: "delivery_branch_mismatch", branch };
      }
      const commitSha = run("git", ["rev-parse", "HEAD"], cwd);
      const commitMessage = run("git", ["log", "-1", "--format=%s%x00%b"], cwd);
      const separator = commitMessage.indexOf("\0");
      const commitSubject = separator >= 0 ? commitMessage.slice(0, separator).trim() : commitMessage;
      const commitBody = separator >= 0 ? commitMessage.slice(separator + 1).trim() : "";
      const repository = JSON.parse(
        run("gh", ["repo", "view", "--json", "defaultBranchRef"], cwd)
      );
      const defaultBranch = String(repository?.defaultBranchRef?.name || "");
      if (!defaultBranch || defaultBranch !== String(receipt.base_branch)) {
        return {
          verified: false,
          reason: "delivery_base_not_default",
          baseBranch: defaultBranch,
        };
      }
      const rawPr = run(
        "gh",
        [
          "pr",
          "view",
          String(receipt.pr_url),
          "--json",
          "url,number,state,isDraft,headRefName,headRefOid,baseRefName,title,body,statusCheckRollup",
        ],
        cwd
      );
      const pr = JSON.parse(rawPr);
      const ciStatus = resolveCiStatus(pr.statusCheckRollup);
      const evidence = {
        verified: true,
        reason: ciStatus === "success" ? null : "ci_not_successful",
        commitSha,
        commitSubject,
        commitBody,
        branch,
        baseBranch: String(pr.baseRefName || ""),
        prUrl: normalizeUrl(pr.url),
        prNumber: Number(pr.number || 0),
        prState: String(pr.state || "").toUpperCase(),
        prDraft: Boolean(pr.isDraft),
        prHeadBranch: String(pr.headRefName || ""),
        prHeadSha: String(pr.headRefOid || ""),
        prTitle: String(pr.title || ""),
        prBody: String(pr.body || ""),
        ciStatus,
        verifiedAt: new Date().toISOString(),
      };

      if (evidence.prState !== "OPEN") return { ...evidence, verified: false, reason: "pr_not_open" };
      if (evidence.prDraft) return { ...evidence, verified: false, reason: "pr_is_draft" };
      if (evidence.prHeadBranch !== branch) {
        return { ...evidence, verified: false, reason: "pr_head_branch_mismatch" };
      }
      if (evidence.prHeadSha !== commitSha) {
        return { ...evidence, verified: false, reason: "pr_head_commit_mismatch" };
      }

      const binding = validateVerifiedDelivery(evidence, receipt);
      if (!binding.ok) return { ...evidence, verified: false, reason: binding.reason };
      return evidence;
    } catch (error) {
      return { verified: false, reason: "delivery_verification_failed", error: error.message };
    }
  }

  return { verify };
}

function resolveCiStatus(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return "pending";
  let pending = false;
  for (const check of rollup) {
    const type = String(check?.__typename || "").toLowerCase();
    if (type === "checkrun" || Object.prototype.hasOwnProperty.call(check || {}, "conclusion")) {
      const status = String(check?.status || "").toLowerCase();
      const conclusion = String(check?.conclusion || "").toLowerCase();
      if (status !== "completed" || !conclusion) {
        pending = true;
      } else if (!SUCCESSFUL_CHECK_CONCLUSIONS.has(conclusion)) {
        return "failure";
      }
      continue;
    }
    const state = String(check?.state || "").toLowerCase();
    if (state === "success") continue;
    if (["pending", "expected", "queued"].includes(state) || !state) pending = true;
    else return "failure";
  }
  return pending ? "pending" : "success";
}

function normalizeUrl(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

module.exports = {
  createDeliveryVerifier,
  resolveCiStatus,
  SUCCESSFUL_CHECK_CONCLUSIONS,
};

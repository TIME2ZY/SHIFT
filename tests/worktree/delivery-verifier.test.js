"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createDeliveryVerifier,
  resolveCiStatus,
} = require("../../src/worktree/delivery-verifier");

const SHA = "a".repeat(40);
const PR_URL = "https://github.com/acme/repo/pull/7";

function commandRunner(_command, args) {
  const command = args.join(" ");
  if (command === "status --porcelain") return { status: 0, stdout: "" };
  if (command === "branch --show-current") {
    return { status: 0, stdout: "codex/session-1\n" };
  }
  if (command === "rev-parse HEAD") return { status: 0, stdout: `${SHA}\n` };
  if (command === "log -1 --format=%s%x00%b") {
    return {
      status: 0,
      stdout:
        "feat(collab): verify delivery evidence\0Bind the reviewed commit to the pull request and CI evidence.\n",
    };
  }
  if (args[0] === "repo" && args[1] === "view") {
    return { status: 0, stdout: JSON.stringify({ defaultBranchRef: { name: "master" } }) };
  }
  if (args[0] === "pr" && args[1] === "view") {
    return {
      status: 0,
      stdout: JSON.stringify({
        url: PR_URL,
        number: 7,
        state: "OPEN",
        isDraft: false,
        headRefName: "codex/session-1",
        headRefOid: SHA,
        baseRefName: "master",
        title: "Verify OpenCode delivery evidence",
        body: [
          "## 意图",
          "交付经过审查的实现",
          "## 主链路影响",
          "不改变 invocation 主链路",
          "## 路径变化（公开入口 / 双写）",
          "没有新增公开入口或双写",
          "## 测试（旧接口测试是否处理）",
          "相关验证通过，未保留旧接口测试",
          "## 风险与回滚",
          "风险可通过回滚该提交消除",
          "来自 deepseek-v4-flash",
        ].join("\n\n"),
        statusCheckRollup: [
          { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
        ],
      }),
    };
  }
  return { status: 1, stderr: `unexpected command: ${command}` };
}

test("delivery verifier binds a clean worktree commit to a ready PR and green CI", () => {
  const verifier = createDeliveryVerifier({ commandRunner });
  const result = verifier.verify({
    cwd: process.cwd(),
    branch: "codex/session-1",
    receipt: {
      commit_sha: SHA,
      pr_url: PR_URL,
      base_branch: "master",
      verification: ["npm run verify:pr: passed"],
    },
  });
  assert.equal(result.verified, true);
  assert.equal(result.reason, null);
  assert.equal(result.ciStatus, "success");
  assert.equal(result.commitSha, SHA);
});

test("delivery verifier fails closed when the managed worktree is dirty", () => {
  const verifier = createDeliveryVerifier({
    commandRunner(command, args, options) {
      if (args.join(" ") === "status --porcelain") {
        return { status: 0, stdout: " M src/file.js\n" };
      }
      return commandRunner(command, args, options);
    },
  });
  const result = verifier.verify({
    cwd: process.cwd(),
    branch: "codex/session-1",
    receipt: {
      commit_sha: SHA,
      pr_url: PR_URL,
      base_branch: "master",
      verification: ["npm run verify:pr: passed"],
    },
  });
  assert.equal(result.verified, false);
  assert.equal(result.reason, "delivery_worktree_dirty");
});

test("CI rollup distinguishes success, pending, and failure", () => {
  assert.equal(resolveCiStatus([]), "pending");
  assert.equal(
    resolveCiStatus([{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" }]),
    "pending"
  );
  assert.equal(
    resolveCiStatus([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }]),
    "failure"
  );
  assert.equal(resolveCiStatus([{ __typename: "StatusContext", state: "SUCCESS" }]), "success");
});

test("verifyWorktreeHandoff succeeds for clean worktree with new commit", () => {
  const verifier = createDeliveryVerifier({
    commandRunner(_cmd, args) {
      const line = args.join(" ");
      if (line === "status --porcelain") return { status: 0, stdout: "" };
      if (line === "rev-parse HEAD") return { status: 0, stdout: "b".repeat(40) + "\n" };
      if (line.startsWith("cat-file -e")) return { status: 0, stdout: "" };
      return { status: 1, stderr: "unexpected" };
    },
  });

  const result = verifier.verifyWorktreeHandoff({
    cwd: process.cwd(),
    startHeadSha: "a".repeat(40),
    requireNewCommit: true,
    commitSha: "b".repeat(40),
  });

  assert.equal(result.verified, true);
  assert.equal(result.clean, true);
  assert.equal(result.headSha, "b".repeat(40));
});

test("verifyWorktreeHandoff fails closed if worktree has uncommitted changes", () => {
  const verifier = createDeliveryVerifier({
    commandRunner(_cmd, args) {
      if (args.join(" ") === "status --porcelain") {
        return { status: 0, stdout: " M src/index.js\n" };
      }
      return { status: 0, stdout: "" };
    },
  });

  const result = verifier.verifyWorktreeHandoff({
    cwd: process.cwd(),
    startHeadSha: "a".repeat(40),
    requireNewCommit: true,
  });

  assert.equal(result.verified, false);
  assert.equal(result.reason, "worktree_dirty");
  assert.match(result.message, /未提交改动/);
});

test("verifyWorktreeHandoff fails closed if implementation produced no new commit", () => {
  const head = "a".repeat(40);
  const verifier = createDeliveryVerifier({
    commandRunner(_cmd, args) {
      const line = args.join(" ");
      if (line === "status --porcelain") return { status: 0, stdout: "" };
      if (line === "rev-parse HEAD") return { status: 0, stdout: `${head}\n` };
      return { status: 1, stderr: "unexpected" };
    },
  });

  const result = verifier.verifyWorktreeHandoff({
    cwd: process.cwd(),
    startHeadSha: head,
    requireNewCommit: true,
  });

  assert.equal(result.verified, false);
  assert.equal(result.reason, "worktree_no_new_commit");
  assert.match(result.message, /未产生新的 commit/);
});

test("verifyWorktreeHandoff fails closed if referenced commit does not exist", () => {
  const verifier = createDeliveryVerifier({
    commandRunner(_cmd, args) {
      const line = args.join(" ");
      if (line === "status --porcelain") return { status: 0, stdout: "" };
      if (line === "rev-parse HEAD") return { status: 0, stdout: "b".repeat(40) + "\n" };
      if (line.startsWith("cat-file -e")) return { status: 1, stderr: "not found" };
      return { status: 1, stderr: "unexpected" };
    },
  });

  const result = verifier.verifyWorktreeHandoff({
    cwd: process.cwd(),
    startHeadSha: "a".repeat(40),
    requireNewCommit: true,
    commitSha: "c".repeat(40),
  });

  assert.equal(result.verified, false);
  assert.equal(result.reason, "commit_not_found");
  assert.match(result.message, /在 git 中不存在/);
});


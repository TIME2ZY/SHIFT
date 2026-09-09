const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const worktrees = require("../../src/worktree/manager");

test("sanitizeId rejects path-like worktree session IDs", () => {
  assert.throws(() => worktrees.sanitizeId(".."), /sessionId/);
  assert.throws(() => worktrees.sanitizeId("../outside"), /sessionId/);
});

function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-manager-repo-"));
  spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["config", "user.name", "Test User"], { cwd: dir, encoding: "utf8" });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir, encoding: "utf8" });
  return dir;
}

function realPath(target) {
  try {
    return fs.realpathSync.native(path.resolve(target));
  } catch {
    return path.resolve(target);
  }
}

function createTestManager(baseDir) {
  return worktrees.createWorktreeManager({
    rootDir: baseDir,
    stateFile: path.join(baseDir, "worktrees-state.json"),
  });
}

test("ensureWorktree creates a managed git worktree for a session", () => {
  const baseDir = makeGitRepo();
  const manager = createTestManager(baseDir);

  const meta = manager.ensureWorktree({ baseDir, sessionId: "session-1" });

  assert.equal(meta.sessionId, "session-1");
  assert.equal(meta.baseDir, realPath(baseDir));
  assert.equal(meta.branch, "codex/session-session-1");
  assert.equal(meta.status, "active");
  assert.ok(meta.worktreeDir.startsWith(realPath(`${baseDir}.worktrees`) + path.sep));
  assert.ok(fs.existsSync(path.join(meta.worktreeDir, ".git")));
  assert.ok(fs.existsSync(path.join(meta.worktreeDir, ".env.local")));
  assert.match(
    fs.readFileSync(path.join(meta.worktreeDir, ".env.local"), "utf8"),
    /SHIFT_WORKTREE=1/
  );
});

test("default worktree state file is under SHIFT_HOME/data", () => {
  const baseDir = makeGitRepo();
  const shiftHome = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-state-home-"));
  const manager = worktrees.createWorktreeManager({
    rootDir: baseDir,
    env: { SHIFT_HOME: shiftHome },
  });
  manager.ensureWorktree({ baseDir, sessionId: "state-path-session" });

  const expectedState = path.join(shiftHome, "data", "worktrees.json");
  assert.ok(fs.existsSync(expectedState), `expected state at ${expectedState}`);
  assert.equal(fs.existsSync(path.join(baseDir, ".invoke-worktrees.json")), false);

  const state = JSON.parse(fs.readFileSync(expectedState, "utf8"));
  assert.ok(state.worktrees["state-path-session"]);
});

test("ensureWorktree reuses the same worktree for the same session", () => {
  const baseDir = makeGitRepo();
  const manager = createTestManager(baseDir);

  const first = manager.ensureWorktree({ baseDir, sessionId: "same-session" });
  const second = manager.ensureWorktree({ baseDir, sessionId: "same-session" });

  assert.deepEqual(second, first);
});

test("getStatus reports branch, dirty state, and porcelain lines", () => {
  const baseDir = makeGitRepo();
  const manager = createTestManager(baseDir);
  const meta = manager.ensureWorktree({ baseDir, sessionId: "status-session" });
  fs.writeFileSync(path.join(meta.worktreeDir, "changed.txt"), "dirty\n", "utf8");

  const status = manager.getStatus("status-session");

  assert.equal(status.sessionId, "status-session");
  assert.equal(status.branch, "codex/session-status-session");
  assert.match(status.headSha, /^[a-f0-9]{40}$/);
  assert.equal(status.clean, false);
  assert.deepEqual(status.porcelain, ["?? changed.txt"]);
});

test("getDiff returns the worktree diff including untracked files", () => {
  const baseDir = makeGitRepo();
  const manager = createTestManager(baseDir);
  const meta = manager.ensureWorktree({ baseDir, sessionId: "diff-session" });
  fs.writeFileSync(path.join(meta.worktreeDir, "new-file.txt"), "new content\n", "utf8");

  const diff = manager.getDiff("diff-session");

  assert.match(diff, /new-file\.txt/);
  assert.match(diff, /\+new content/);
});

test("discardWorktree removes only a managed worktree directory", () => {
  const baseDir = makeGitRepo();
  const manager = createTestManager(baseDir);
  const meta = manager.ensureWorktree({ baseDir, sessionId: "discard-session" });

  const discarded = manager.discardWorktree("discard-session");

  assert.equal(discarded.ok, true);
  assert.equal(fs.existsSync(meta.worktreeDir), false);
  assert.throws(() => manager.discardWorktree("discard-session"), /No managed worktree/);
});

test("discardWorktree refuses a state-file path that Git has not registered", () => {
  const baseDir = makeGitRepo();
  const stateFile = path.join(baseDir, "worktrees-state.json");
  const manager = worktrees.createWorktreeManager({ rootDir: baseDir, stateFile });
  const meta = manager.ensureWorktree({ baseDir, sessionId: "tampered-session" });
  const ordinaryDir = path.join(`${baseDir}.worktrees`, "ordinary-dir");
  fs.mkdirSync(ordinaryDir, { recursive: true });
  fs.writeFileSync(path.join(ordinaryDir, "keep.txt"), "keep\n", "utf8");

  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.worktrees["tampered-session"].worktreeDir = ordinaryDir;
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  assert.throws(() => manager.discardWorktree("tampered-session"), /unregistered worktree/);
  assert.equal(fs.existsSync(path.join(ordinaryDir, "keep.txt")), true);

  state.worktrees["tampered-session"] = meta;
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  manager.discardWorktree("tampered-session");
});

test("ensureWorktree rejects non-git base directories", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-manager-not-git-"));
  const manager = createTestManager(baseDir);

  assert.throws(
    () => manager.ensureWorktree({ baseDir, sessionId: "bad-session" }),
    /not a git repository/i
  );
});

test("checkHealth detects missing directory and reconcileWorktree clears state", () => {
  const baseDir = makeGitRepo();
  const manager = createTestManager(baseDir);
  const meta = manager.ensureWorktree({ baseDir, sessionId: "session-del" });

  fs.rmSync(meta.worktreeDir, { recursive: true, force: true });

  const health = manager.checkHealth("session-del");
  assert.equal(health.ok, false);
  assert.equal(health.reason, "directory_missing");

  const rec = manager.reconcileWorktree("session-del");
  assert.equal(rec.reconciled, true);

  const after = manager.checkHealth("session-del");
  assert.equal(after.ok, false);
  assert.equal(after.reason, "not_found");
});

test("ensureWorktree auto-recreates unhealthy worktree when directory is deleted", () => {
  const baseDir = makeGitRepo();
  const manager = createTestManager(baseDir);
  const meta = manager.ensureWorktree({ baseDir, sessionId: "session-recreate" });

  fs.rmSync(meta.worktreeDir, { recursive: true, force: true });
  assert.equal(fs.existsSync(meta.worktreeDir), false);

  const recreated = manager.ensureWorktree({ baseDir, sessionId: "session-recreate" });
  assert.equal(recreated.sessionId, "session-recreate");
  assert.equal(fs.existsSync(recreated.worktreeDir), true);

  const status = manager.getStatus("session-recreate");
  assert.equal(status.clean, true);
});

test("checkHealth detects missing branch and ensureWorktree recovers", () => {
  const baseDir = makeGitRepo();
  const manager = createTestManager(baseDir);
  const meta = manager.ensureWorktree({ baseDir, sessionId: "branch-del" });

  // Delete the worktree and branch
  spawnSync("git", ["worktree", "remove", "--force", meta.worktreeDir], { cwd: baseDir });
  spawnSync("git", ["branch", "-D", meta.branch], { cwd: baseDir });

  const health = manager.checkHealth("branch-del");
  assert.equal(health.ok, false);

  const recovered = manager.ensureWorktree({ baseDir, sessionId: "branch-del" });
  assert.equal(recovered.sessionId, "branch-del");
  assert.equal(fs.existsSync(recovered.worktreeDir), true);
  assert.equal(manager.checkHealth("branch-del").ok, true);
});

test("getStatus auto-reconciles broken worktree and throws No managed worktree", () => {
  const baseDir = makeGitRepo();
  const stateFile = path.join(baseDir, "worktrees-state.json");
  const manager = worktrees.createWorktreeManager({ rootDir: baseDir, stateFile });
  const meta = manager.ensureWorktree({ baseDir, sessionId: "status-reconcile" });

  fs.rmSync(meta.worktreeDir, { recursive: true, force: true });

  assert.throws(() => manager.getStatus("status-reconcile"), /No managed worktree/);

  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(Boolean(state.worktrees["status-reconcile"]), false);
});

test("reconcileAllWorktrees cleans up all orphaned worktrees", () => {
  const baseDir = makeGitRepo();
  const manager = createTestManager(baseDir);
  const meta1 = manager.ensureWorktree({ baseDir, sessionId: "s1" });
  const _meta2 = manager.ensureWorktree({ baseDir, sessionId: "s2" });

  fs.rmSync(meta1.worktreeDir, { recursive: true, force: true });

  const results = manager.reconcileAllWorktrees();
  assert.equal(results.length, 1);
  assert.equal(results[0].sessionId, "s1");

  assert.equal(manager.checkHealth("s1").ok, false);
  assert.equal(manager.checkHealth("s2").ok, true);
});

test("automatic reconciliation preserves files when Git metadata is damaged", () => {
  const baseDir = makeGitRepo();
  const manager = createTestManager(baseDir);
  const meta = manager.ensureWorktree({ baseDir, sessionId: "preserve-draft" });
  const draft = path.join(meta.worktreeDir, "draft.txt");
  fs.writeFileSync(draft, "uncommitted work");
  fs.renameSync(path.join(meta.worktreeDir, ".git"), path.join(meta.worktreeDir, ".git.saved"));
  assert.equal(manager.checkHealth("preserve-draft").ok, false);
  fs.writeFileSync(path.join(meta.worktreeDir, ".git"), "gitdir: missing-metadata\n");
  assert.equal(manager.checkHealth("preserve-draft").ok, false);
  manager.reconcileAllWorktrees();
  assert.throws(
    () => manager.ensureWorktree({ baseDir, sessionId: "preserve-draft" }),
    /preserved/
  );
  assert.equal(fs.readFileSync(draft, "utf8"), "uncommitted work");
});

test("recreating a missing worktree retains its committed session history", () => {
  const baseDir = makeGitRepo();
  const manager = createTestManager(baseDir);
  const meta = manager.ensureWorktree({ baseDir, sessionId: "preserve-commit" });
  fs.writeFileSync(path.join(meta.worktreeDir, "result.txt"), "session result");
  for (const args of [
    ["add", "result.txt"],
    ["commit", "-m", "session result"],
  ]) {
    assert.equal(spawnSync("git", args, { cwd: meta.worktreeDir }).status, 0);
  }
  const head = manager.getStatus("preserve-commit").headSha;
  assert.equal(
    spawnSync("git", ["worktree", "remove", meta.worktreeDir], { cwd: baseDir }).status,
    0
  );
  manager.ensureWorktree({ baseDir, sessionId: "preserve-commit" });
  assert.equal(manager.getStatus("preserve-commit").headSha, head);
  assert.equal(
    fs.readFileSync(path.join(meta.worktreeDir, "result.txt"), "utf8"),
    "session result"
  );
});

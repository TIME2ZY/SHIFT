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

test("ensureWorktree creates a managed git worktree for a session", () => {
  const baseDir = makeGitRepo();
  const manager = worktrees.createWorktreeManager({ rootDir: baseDir });

  const meta = manager.ensureWorktree({ baseDir, sessionId: "session-1" });

  assert.equal(meta.sessionId, "session-1");
  assert.equal(meta.baseDir, realPath(baseDir));
  assert.equal(meta.branch, "codex/session-session-1");
  assert.equal(meta.status, "active");
  assert.ok(meta.worktreeDir.startsWith(realPath(`${baseDir}.worktrees`) + path.sep));
  assert.ok(fs.existsSync(path.join(meta.worktreeDir, ".git")));
  assert.ok(fs.existsSync(path.join(meta.worktreeDir, ".env.local")));
  assert.match(fs.readFileSync(path.join(meta.worktreeDir, ".env.local"), "utf8"), /SHIFT_WORKTREE=1/);
});

test("default worktree state file is under rootDir/data/runtime", () => {
  const baseDir = makeGitRepo();
  const manager = worktrees.createWorktreeManager({ rootDir: baseDir });
  manager.ensureWorktree({ baseDir, sessionId: "state-path-session" });

  const expectedState = path.join(baseDir, "data", "runtime", "worktrees.json");
  assert.ok(fs.existsSync(expectedState), `expected state at ${expectedState}`);
  assert.equal(fs.existsSync(path.join(baseDir, ".invoke-worktrees.json")), false);

  const state = JSON.parse(fs.readFileSync(expectedState, "utf8"));
  assert.ok(state.worktrees["state-path-session"]);
});

test("ensureWorktree reuses the same worktree for the same session", () => {
  const baseDir = makeGitRepo();
  const manager = worktrees.createWorktreeManager({ rootDir: baseDir });

  const first = manager.ensureWorktree({ baseDir, sessionId: "same-session" });
  const second = manager.ensureWorktree({ baseDir, sessionId: "same-session" });

  assert.deepEqual(second, first);
});

test("getStatus reports branch, dirty state, and porcelain lines", () => {
  const baseDir = makeGitRepo();
  const manager = worktrees.createWorktreeManager({ rootDir: baseDir });
  const meta = manager.ensureWorktree({ baseDir, sessionId: "status-session" });
  fs.writeFileSync(path.join(meta.worktreeDir, "changed.txt"), "dirty\n", "utf8");

  const status = manager.getStatus("status-session");

  assert.equal(status.sessionId, "status-session");
  assert.equal(status.branch, "codex/session-status-session");
  assert.equal(status.clean, false);
  assert.deepEqual(status.porcelain, ["?? changed.txt"]);
});

test("getDiff returns the worktree diff including untracked files", () => {
  const baseDir = makeGitRepo();
  const manager = worktrees.createWorktreeManager({ rootDir: baseDir });
  const meta = manager.ensureWorktree({ baseDir, sessionId: "diff-session" });
  fs.writeFileSync(path.join(meta.worktreeDir, "new-file.txt"), "new content\n", "utf8");

  const diff = manager.getDiff("diff-session");

  assert.match(diff, /new-file\.txt/);
  assert.match(diff, /\+new content/);
});

test("discardWorktree removes only a managed worktree directory", () => {
  const baseDir = makeGitRepo();
  const manager = worktrees.createWorktreeManager({ rootDir: baseDir });
  const meta = manager.ensureWorktree({ baseDir, sessionId: "discard-session" });

  const discarded = manager.discardWorktree("discard-session");

  assert.equal(discarded.ok, true);
  assert.equal(fs.existsSync(meta.worktreeDir), false);
  assert.throws(
    () => manager.discardWorktree("discard-session"),
    /No managed worktree/
  );
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

  assert.throws(
    () => manager.discardWorktree("tampered-session"),
    /unregistered worktree/
  );
  assert.equal(fs.existsSync(path.join(ordinaryDir, "keep.txt")), true);

  state.worktrees["tampered-session"] = meta;
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  manager.discardWorktree("tampered-session");
});

test("ensureWorktree rejects non-git base directories", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-manager-not-git-"));
  const manager = worktrees.createWorktreeManager({ rootDir: baseDir });

  assert.throws(
    () => manager.ensureWorktree({ baseDir, sessionId: "bad-session" }),
    /not a git repository/i
  );
});

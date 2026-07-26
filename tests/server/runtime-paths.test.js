const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const runtimePaths = require("../../src/shared/runtime-paths");

test("runtime paths live under data/runtime", () => {
  const root = path.resolve(__dirname, "../..");
  const runtimeDir = path.join(root, "data", "runtime");

  assert.equal(runtimePaths.ROOT, root);
  assert.equal(runtimePaths.RUNTIME_DATA_DIR, runtimeDir);
  assert.equal(runtimePaths.DEFAULT_SESSIONS_FILE, path.join(runtimeDir, "sessions.json"));
  assert.equal(runtimePaths.DEFAULT_INVOCATIONS_FILE, path.join(runtimeDir, "invocations.json"));
  assert.equal(runtimePaths.DEFAULT_SESSION_MAP_ROOT, path.join(runtimeDir, "session-maps"));
  assert.equal(runtimePaths.DEFAULT_TRANSCRIPT_DIR, path.join(runtimeDir, "transcripts"));
  assert.equal(
    runtimePaths.DEFAULT_AUDIT_TRANSCRIPT_DIR,
    path.join(runtimeDir, "audit-transcripts")
  );
  assert.equal(runtimePaths.DEFAULT_WORKTREE_STATE_FILE, path.join(runtimeDir, "worktrees.json"));
  assert.equal(runtimePaths.DEFAULT_RAW_EVENTS_DIR, path.join(runtimeDir, "raw-events"));
  assert.equal(runtimePaths.LEGACY_MEMORY_DB_FILE, path.join(runtimeDir, "memory.sqlite"));
  assert.equal(runtimePaths.DEFAULT_MEMORY_DB_FILE, path.join(runtimeDir, "shift.sqlite"));
});

test("worktreeStateFileFor nests under root/data/runtime", () => {
  const tmpRoot = path.join(path.sep === "\\" ? "C:\\tmp" : "/tmp", "shift-root");
  assert.equal(
    runtimePaths.worktreeStateFileFor(tmpRoot),
    path.join(path.resolve(tmpRoot), "data", "runtime", "worktrees.json")
  );
  assert.equal(
    runtimePaths.worktreeStateFileFor(runtimePaths.ROOT),
    runtimePaths.DEFAULT_WORKTREE_STATE_FILE
  );
});

test("pathsOverlap detects equal and nested paths without matching siblings", () => {
  const root = path.resolve("runtime");
  assert.equal(runtimePaths.pathsOverlap(root, root), true);
  assert.equal(runtimePaths.pathsOverlap(root, path.join(root, "audit")), true);
  assert.equal(
    runtimePaths.pathsOverlap(path.join(root, "transcripts"), path.join(root, "audit")),
    false
  );
});

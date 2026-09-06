const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const runtimePaths = require("../../src/shared/runtime-paths");

test("runtime paths derive every online artifact from SHIFT_HOME/data", () => {
  const homeDir = path.resolve("fixture-user-home");
  const shiftHome = path.join(homeDir, ".shift-custom");
  const paths = runtimePaths.createRuntimePaths({
    env: { SHIFT_HOME: shiftHome },
    homeDir,
  });
  const dataDir = path.join(shiftHome, "data");

  assert.equal(paths.shiftHome, shiftHome);
  assert.equal(paths.agentsConfigFile, path.join(shiftHome, "agents.json"));
  assert.equal(paths.dataDir, dataDir);
  assert.equal(paths.databaseFile, path.join(dataDir, "shift.sqlite"));
  assert.equal(paths.auditTranscriptDir, path.join(dataDir, "audit-transcripts"));
  assert.equal(paths.rawEventsDir, path.join(dataDir, "raw-events"));
  assert.equal(paths.transcriptDir, path.join(dataDir, "transcripts"));
  assert.equal(paths.worktreeStateFile, path.join(dataDir, "worktrees.json"));
  assert.equal(paths.migrationDir, path.join(dataDir, "migration"));
  assert.equal(paths.backupDir, path.join(dataDir, "backups"));
});

test("runtime paths default to the user .shift directory", () => {
  const homeDir = path.resolve("fixture-default-home");
  const paths = runtimePaths.createRuntimePaths({ env: {}, homeDir });
  assert.equal(paths.shiftHome, path.join(homeDir, ".shift"));
  assert.equal(paths.dataDir, path.join(homeDir, ".shift", "data"));
});

test("SHIFT_HOME expands a leading tilde and rejects filesystem roots", () => {
  const homeDir = path.resolve("fixture-tilde-home");
  assert.equal(
    runtimePaths.resolveShiftHome("~/.shift-alt", homeDir),
    path.join(homeDir, ".shift-alt")
  );
  const filesystemRoot = path.parse(path.resolve("fixture")).root;
  assert.throws(
    () => runtimePaths.resolveShiftHome(filesystemRoot, homeDir),
    /must not be a filesystem root/
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

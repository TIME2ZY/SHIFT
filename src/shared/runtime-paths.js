const os = require("node:os");
const path = require("node:path");

const { LOCAL_STATE_DIR } = require("./brand");

const ROOT = path.resolve(__dirname, "../..");

function resolveShiftHome(value, homeDir = os.homedir()) {
  const raw = typeof value === "string" ? value.trim() : "";
  const resolved = raw
    ? path.resolve(expandHomePrefix(raw, homeDir))
    : path.resolve(homeDir, LOCAL_STATE_DIR);
  if (resolved === path.parse(resolved).root) {
    throw new Error(`SHIFT_HOME must not be a filesystem root: ${resolved}`);
  }
  return resolved;
}

function createRuntimePaths(options = {}) {
  const env = options.env || process.env;
  const shiftHome = resolveShiftHome(env.SHIFT_HOME, options.homeDir);
  const dataDir = path.join(shiftHome, "data");
  return Object.freeze({
    shiftHome,
    dataDir,
    databaseFile: path.join(dataDir, "shift.sqlite"),
    auditTranscriptDir: path.join(dataDir, "audit-transcripts"),
    rawEventsDir: path.join(dataDir, "raw-events"),
    transcriptDir: path.join(dataDir, "transcripts"),
    worktreeStateFile: path.join(dataDir, "worktrees.json"),
    migrationDir: path.join(dataDir, "migration"),
    backupDir: path.join(dataDir, "backups"),
  });
}

function expandHomePrefix(value, homeDir) {
  if (value === "~") return path.resolve(homeDir);
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(path.resolve(homeDir), value.slice(2));
  }
  return value;
}

function pathsOverlap(left, right) {
  return (
    isSameOrAncestor(path.resolve(left), path.resolve(right)) ||
    isSameOrAncestor(path.resolve(right), path.resolve(left))
  );
}

function isSameOrAncestor(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

const DEFAULT_RUNTIME_PATHS = createRuntimePaths();

module.exports = {
  ROOT,
  DEFAULT_RUNTIME_PATHS,
  DEFAULT_MEMORY_DB_FILE: DEFAULT_RUNTIME_PATHS.databaseFile,
  DEFAULT_TRANSCRIPT_DIR: DEFAULT_RUNTIME_PATHS.transcriptDir,
  DEFAULT_AUDIT_TRANSCRIPT_DIR: DEFAULT_RUNTIME_PATHS.auditTranscriptDir,
  DEFAULT_WORKTREE_STATE_FILE: DEFAULT_RUNTIME_PATHS.worktreeStateFile,
  DEFAULT_RAW_EVENTS_DIR: DEFAULT_RUNTIME_PATHS.rawEventsDir,
  createRuntimePaths,
  resolveShiftHome,
  pathsOverlap,
};

const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const RUNTIME_DATA_DIR = path.join(ROOT, "data", "runtime");
const DEFAULT_SESSIONS_FILE = path.join(RUNTIME_DATA_DIR, "sessions.json");
const DEFAULT_INVOCATIONS_FILE = path.join(RUNTIME_DATA_DIR, "invocations.json");
const DEFAULT_SESSION_MAP_ROOT = path.join(RUNTIME_DATA_DIR, "session-maps");
const DEFAULT_TRANSCRIPT_DIR = path.join(RUNTIME_DATA_DIR, "transcripts");
const DEFAULT_WORKTREE_STATE_FILE = path.join(RUNTIME_DATA_DIR, "worktrees.json");
const DEFAULT_RAW_EVENTS_DIR = path.join(RUNTIME_DATA_DIR, "raw-events");
const LEGACY_MEMORY_DB_FILE = path.join(RUNTIME_DATA_DIR, "memory.sqlite");
// The authoritative database owns sessions, invocations, memory, and derived
// projections. Keep it separate from the pre-cutover memory.sqlite validation
// database so a default startup can never activate or reuse legacy data.
const DEFAULT_MEMORY_DB_FILE = path.join(RUNTIME_DATA_DIR, "shift.sqlite");

/**
 * Worktree state file under a given app root (tests may use a temp root).
 * Production default equals DEFAULT_WORKTREE_STATE_FILE when rootDir is ROOT.
 */
function worktreeStateFileFor(rootDir) {
  return path.join(path.resolve(rootDir), "data", "runtime", "worktrees.json");
}

module.exports = {
  ROOT,
  RUNTIME_DATA_DIR,
  DEFAULT_SESSIONS_FILE,
  DEFAULT_INVOCATIONS_FILE,
  DEFAULT_SESSION_MAP_ROOT,
  DEFAULT_TRANSCRIPT_DIR,
  DEFAULT_WORKTREE_STATE_FILE,
  DEFAULT_RAW_EVENTS_DIR,
  LEGACY_MEMORY_DB_FILE,
  DEFAULT_MEMORY_DB_FILE,
  worktreeStateFileFor,
};

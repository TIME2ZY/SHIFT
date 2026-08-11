const path = require("node:path");

const { ROOT } = require("../../shared/runtime-paths");

const LEGACY_RUNTIME_DATA_DIR = path.join(ROOT, "data", "runtime");

module.exports = Object.freeze({
  LEGACY_RUNTIME_DATA_DIR,
  LEGACY_SESSIONS_FILE: path.join(LEGACY_RUNTIME_DATA_DIR, "sessions.json"),
  LEGACY_INVOCATIONS_FILE: path.join(LEGACY_RUNTIME_DATA_DIR, "invocations.json"),
  LEGACY_SESSION_MAP_ROOT: path.join(LEGACY_RUNTIME_DATA_DIR, "session-maps"),
  LEGACY_TRANSCRIPT_DIR: path.join(LEGACY_RUNTIME_DATA_DIR, "transcripts"),
  LEGACY_AUDIT_TRANSCRIPT_DIR: path.join(LEGACY_RUNTIME_DATA_DIR, "audit-transcripts"),
  LEGACY_WORKTREE_STATE_FILE: path.join(LEGACY_RUNTIME_DATA_DIR, "worktrees.json"),
  LEGACY_RAW_EVENTS_DIR: path.join(LEGACY_RUNTIME_DATA_DIR, "raw-events"),
  LEGACY_MEMORY_DB_FILE: path.join(LEGACY_RUNTIME_DATA_DIR, "memory.sqlite"),
  LEGACY_DATABASE_FILE: path.join(LEGACY_RUNTIME_DATA_DIR, "shift.sqlite"),
});

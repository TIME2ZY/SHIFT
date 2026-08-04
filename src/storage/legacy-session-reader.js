const fs = require("node:fs");

/**
 * Read-only parser for historical sessions.json snapshots used by offline
 * divergence audits. Product session reads and writes are SQLite-only.
 */
function readLegacySessions(sessionsFile) {
  if (!fs.existsSync(sessionsFile)) return { sessions: {}, lastSessionId: null };

  try {
    const parsed = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { sessions: {}, lastSessionId: null };
    }
    return {
      sessions:
        parsed.sessions && typeof parsed.sessions === "object" && !Array.isArray(parsed.sessions)
          ? parsed.sessions
          : {},
      lastSessionId: typeof parsed.lastSessionId === "string" ? parsed.lastSessionId : null,
    };
  } catch {
    return { sessions: {}, lastSessionId: null };
  }
}

module.exports = { readLegacySessions };

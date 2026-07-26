const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

function buildLegacyCleanupManifest({ paths = {}, epoch = null, generatedAt } = {}) {
  const at = validTimestamp(generatedAt) || new Date().toISOString();
  const targets = [
    target("sessions", paths.sessionsFile, "legacy session/message JSON"),
    target("invocations", paths.invocationsFile, "legacy invocation registry"),
    target("transcripts", paths.transcriptDir, "legacy invocation transcripts"),
    target("session-maps", paths.sessionMapRoot, "legacy provider resume mappings"),
  ].filter(Boolean);

  if (["legacy-validation", "pre-epoch-legacy"].includes(epoch?.dataPolicy)) {
    const database = target(
      "legacy-validation-db",
      paths.memoryDbFile,
      "pre-cutover SQLite validation database"
    );
    if (database) targets.push(database);
    const wal = target(
      "legacy-validation-db-wal",
      paths.memoryDbFile ? `${paths.memoryDbFile}-wal` : "",
      "pre-cutover SQLite write-ahead log"
    );
    if (wal) targets.push(wal);
    const shm = target(
      "legacy-validation-db-shm",
      paths.memoryDbFile ? `${paths.memoryDbFile}-shm` : "",
      "pre-cutover SQLite shared-memory sidecar"
    );
    if (shm) targets.push(shm);
  }

  return {
    manifestVersion: 1,
    generatedAt: at,
    action: "plan-only",
    destructive: false,
    readyToDelete: false,
    epoch: epoch
      ? {
          epochId: epoch.epochId || null,
          schemaVersion: epoch.schemaVersion || null,
          dataPolicy: epoch.dataPolicy || null,
          cutoverTime: epoch.cutoverTime || null,
          isActive: Boolean(epoch.isActive),
        }
      : null,
    dataRange: epoch?.cutoverTime
      ? { before: epoch.cutoverTime, inclusive: false }
      : { policy: "all pre-cutover legacy data" },
    recoverability:
      "Permanent deletion is not recoverable unless a separately retained SQLite backup exists.",
    prerequisites: [
      "default online mode is sqlite",
      "clean storage epoch is active",
      "SQLite recovery drill passed",
      "derived-model rebuild passed",
      "storage audit and integrity checks passed",
      "legacy scenarios use sanitized fixtures",
      "explicit deletion approval recorded",
    ],
    targets,
    totals: targets.reduce(
      (sum, item) => ({
        targets: sum.targets + 1,
        existing: sum.existing + (item.exists ? 1 : 0),
        files: sum.files + item.files,
        bytes: sum.bytes + item.bytes,
      }),
      { targets: 0, existing: 0, files: 0, bytes: 0 }
    ),
  };
}

function target(id, value, description) {
  if (typeof value !== "string" || !value.trim()) return null;
  const resolved = path.resolve(value);
  const stats = inspectPath(resolved);
  return {
    id,
    path: resolved,
    description,
    ...stats,
    deletePolicy: "explicit-post-cutover-only",
  };
}

function inspectPath(value) {
  if (!fs.existsSync(value)) {
    return { exists: false, type: "missing", files: 0, bytes: 0 };
  }
  const root = fs.lstatSync(value);
  if (!root.isDirectory()) {
    return {
      exists: true,
      type: root.isSymbolicLink() ? "symlink" : "file",
      files: root.isFile() ? 1 : 0,
      bytes: root.isFile() ? root.size : 0,
    };
  }

  let files = 0;
  let bytes = 0;
  const pending = [value];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile()) {
        files += 1;
        bytes += fs.statSync(child).size;
      }
    }
  }
  return { exists: true, type: "directory", files, bytes };
}

function validTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function readEpochMetadata(databaseFile) {
  if (typeof databaseFile !== "string" || !fs.existsSync(databaseFile)) return null;
  const db = new Database(path.resolve(databaseFile), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const exists = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'storage_metadata' LIMIT 1"
      )
      .get();
    if (!exists) {
      const migrationTable = db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations' LIMIT 1"
        )
        .get();
      if (!migrationTable) return null;
      const schemaVersion =
        db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version || 0;
      return {
        epochId: null,
        schemaVersion,
        dataPolicy: "pre-epoch-legacy",
        cutoverTime: null,
        createdAt: null,
        isClean: false,
        isActive: false,
      };
    }
    const row = db
      .prepare(
        `SELECT epoch_id, schema_version, data_policy, cutover_at, created_at
         FROM storage_metadata WHERE singleton = 1`
      )
      .get();
    if (!row) return null;
    return {
      epochId: row.epoch_id,
      schemaVersion: row.schema_version,
      dataPolicy: row.data_policy,
      cutoverTime: row.cutover_at,
      createdAt: row.created_at,
      isClean: row.data_policy === "clean",
      isActive: row.cutover_at !== null,
    };
  } finally {
    db.close();
  }
}

module.exports = {
  buildLegacyCleanupManifest,
  inspectPath,
  readEpochMetadata,
};

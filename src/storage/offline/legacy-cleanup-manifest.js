const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const { pathsOverlap } = require("../../shared/runtime-paths");

function buildLegacyCleanupManifest({
  paths = {},
  epoch = null,
  generatedAt,
  canonicalCoverage = null,
} = {}) {
  assertCleanActiveEpoch(epoch);
  const at = validTimestamp(generatedAt) || new Date().toISOString();
  const authoritativeDbFile = requiredPath(
    paths.authoritativeDbFile,
    "authoritative database"
  );
  const auditTranscriptDir = optionalPath(paths.auditTranscriptDir);
  const protectedPaths = [
    {
      id: "authoritative-db",
      path: authoritativeDbFile,
      description: "active SQLite business truth source",
    },
    {
      id: "authoritative-db-wal",
      path: `${authoritativeDbFile}-wal`,
      description: "active SQLite write-ahead log",
    },
    {
      id: "authoritative-db-shm",
      path: `${authoritativeDbFile}-shm`,
      description: "active SQLite shared-memory sidecar",
    },
    ...(auditTranscriptDir
      ? [
          {
            id: "canonical-audit",
            path: auditTranscriptDir,
            description: "post-cutover canonical JSONL archive",
          },
        ]
      : []),
  ];

  assertTargetIsSeparated(paths.transcriptDir, auditTranscriptDir, "legacy transcripts");
  assertLegacyTranscriptOnly(paths.transcriptDir, canonicalCoverage);

  const targets = [
    target("sessions", paths.sessionsFile, "legacy session/message JSON"),
    target("invocations", paths.invocationsFile, "legacy invocation registry"),
    target("transcripts", paths.transcriptDir, "legacy invocation transcripts"),
    target("session-maps", paths.sessionMapRoot, "legacy provider resume mappings"),
  ].filter(Boolean);

  const legacyDbFile = optionalPath(paths.legacyDbFile);
  const database = target(
    "legacy-validation-db",
    legacyDbFile,
    "pre-cutover SQLite validation database"
  );
  if (database) targets.push(database);
  const wal = target(
    "legacy-validation-db-wal",
    legacyDbFile ? `${legacyDbFile}-wal` : "",
    "pre-cutover SQLite write-ahead log"
  );
  if (wal) targets.push(wal);
  const shm = target(
    "legacy-validation-db-shm",
    legacyDbFile ? `${legacyDbFile}-shm` : "",
    "pre-cutover SQLite shared-memory sidecar"
  );
  if (shm) targets.push(shm);

  for (const item of targets) {
    for (const protectedItem of protectedPaths) {
      assertPathsDoNotOverlap(item.path, protectedItem.path, item.id, protectedItem.id);
    }
  }

  return {
    manifestVersion: 2,
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
    protectedPaths,
    canonicalCoverage,
    recoverability:
      "Permanent deletion is not recoverable unless a separately retained SQLite backup exists.",
    confirmation: `DELETE_LEGACY:${epoch.epochId}`,
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

function assertCleanActiveEpoch(epoch) {
  if (
    !epoch ||
    epoch.dataPolicy !== "clean" ||
    !epoch.isActive ||
    !validTimestamp(epoch.cutoverTime)
  ) {
    throw new Error(
      "Cleanup planning requires an active clean authoritative epoch with a cutover time."
    );
  }
}

function requiredPath(value, label) {
  const resolved = optionalPath(value);
  if (!resolved) throw new Error(`${label} path is required.`);
  return resolved;
}

function optionalPath(value) {
  return typeof value === "string" && value.trim() ? path.resolve(value) : "";
}

function assertTargetIsSeparated(targetPath, protectedPath, label) {
  if (!targetPath || !protectedPath) return;
  assertPathsDoNotOverlap(targetPath, protectedPath, label, "canonical-audit");
}

function assertPathsDoNotOverlap(left, right, leftLabel, rightLabel) {
  const leftPath = path.resolve(left);
  const rightPath = path.resolve(right);
  if (!pathsOverlap(leftPath, rightPath)) return;
  throw new Error(
    `Cleanup target ${leftLabel} overlaps protected ${rightLabel}: ${leftPath} <> ${rightPath}`
  );
}

function assertLegacyTranscriptOnly(transcriptDir, canonicalCoverage = null) {
  const resolved = optionalPath(transcriptDir);
  if (!resolved || !fs.existsSync(resolved)) return;
  const canonicalFile = findCanonicalAuditFile(resolved);
  if (!canonicalFile) return;
  if (
    canonicalCoverage?.required &&
    canonicalCoverage?.verified &&
    canonicalCoverage?.missingFromAudit?.length === 0
  ) {
    return;
  }
  throw new Error(
    `Legacy transcript cleanup is blocked: canonical audit events were found in ${canonicalFile}. ` +
      "Move or explicitly retire the mixed archive before deletion."
  );
}

function findCanonicalAuditFile(root) {
  const stats = fs.lstatSync(root);
  if (!stats.isDirectory()) {
    return fileContainsCanonicalAudit(root) ? root : "";
  }
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile() && fileContainsCanonicalAudit(child)) return child;
    }
  }
  return "";
}

function fileContainsCanonicalAudit(file) {
  if (path.extname(file).toLowerCase() !== ".jsonl") return false;
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let pending = "";
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      const lines = (pending + buffer.toString("utf8", 0, bytesRead)).split(/\r?\n/);
      pending = lines.pop() || "";
      if (lines.some(lineIsCanonicalAudit)) return true;
    } while (bytesRead > 0);
    return lineIsCanonicalAudit(pending);
  } finally {
    fs.closeSync(descriptor);
  }
}

function lineIsCanonicalAudit(line) {
  if (!line.trim()) return false;
  try {
    const parsed = JSON.parse(line);
    return typeof parsed?.eventId === "string" && Boolean(parsed.eventId);
  } catch {
    return false;
  }
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
      fingerprint: root.isFile() ? fingerprintFiles(value, [value]) : null,
    };
  }

  let files = 0;
  let bytes = 0;
  const filePaths = [];
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
        filePaths.push(child);
      }
    }
  }
  filePaths.sort((left, right) => left.localeCompare(right));
  return {
    exists: true,
    type: "directory",
    files,
    bytes,
    fingerprint: fingerprintFiles(value, filePaths),
  };
}

function fingerprintFiles(root, files) {
  const hash = crypto.createHash("sha256");
  const base = fs.statSync(root).isDirectory() ? root : path.dirname(root);
  for (const file of files) {
    const relative = path.relative(base, file).split(path.sep).join("/");
    const stats = fs.statSync(file);
    hash.update(`${relative}\0${stats.size}\0`);
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
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
  findCanonicalAuditFile,
  inspectPath,
  pathsOverlap,
  readEpochMetadata,
};

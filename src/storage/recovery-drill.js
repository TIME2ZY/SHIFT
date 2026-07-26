const fs = require("node:fs");
const path = require("node:path");
const { createStorage } = require("./index");
const { auditSqliteStorage } = require("./audit-storage");
const { backupDatabase, integrityCheck, rebuildDerivedModels } = require("./maintenance");

const SOURCE_TABLES = Object.freeze([
  "threads",
  "messages",
  "context_windows",
  "invocations",
  "invocation_events",
  "memory_entries",
  "memory_events",
  "memory_suggestions",
  "purged_threads",
]);

async function runSqliteRecoveryDrill({ sourceFile, drillDir, fullIntegrity = true } = {}) {
  const source = requiredPath(sourceFile, "source SQLite file");
  const root = requiredPath(drillDir, "recovery drill directory");
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error(`Source SQLite file does not exist: ${source}`);
  }
  prepareEmptyDirectory(root);

  const backupFile = path.join(root, "backup", "memory.sqlite");
  const restoredFile = path.join(root, "restored", "memory.sqlite");
  const sourceStorage = createStorage({ file: source });
  let sourceSnapshot;
  let backup;
  try {
    sourceSnapshot = snapshot(sourceStorage);
    backup = await backupDatabase(sourceStorage.db, backupFile);
  } finally {
    sourceStorage.close();
  }

  fs.mkdirSync(path.dirname(restoredFile), { recursive: true });
  fs.copyFileSync(backupFile, restoredFile);

  const restoredStorage = createStorage({ file: restoredFile });
  try {
    const restoredSnapshot = snapshot(restoredStorage);
    const integrity = integrityCheck(restoredStorage.db, { full: fullIntegrity });
    const rebuilt = rebuildDerivedModels(restoredStorage);
    const audit = auditSqliteStorage({
      storage: restoredStorage,
      fullIntegrity,
      logger: { error() {} },
    });
    const mismatches = compareSnapshots(sourceSnapshot, restoredSnapshot);
    return {
      ok: integrity.ok && audit.ok && mismatches.length === 0,
      sourceFile: source,
      drillDir: root,
      backup: {
        file: backup.destination,
        bytes: backup.bytes,
      },
      restoredFile,
      source: sourceSnapshot,
      restored: restoredSnapshot,
      mismatches,
      integrity,
      rebuilt,
      audit: {
        ok: audit.ok,
        summary: audit.summary,
      },
    };
  } finally {
    restoredStorage.close();
  }
}

function snapshot(storage) {
  const counts = {};
  for (const table of SOURCE_TABLES) {
    counts[table] = Number(
      storage.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count || 0
    );
  }
  return {
    epoch: storage.metadata.getCurrent(),
    counts,
  };
}

function compareSnapshots(source, restored) {
  const mismatches = [];
  if (source.epoch.epochId !== restored.epoch.epochId) {
    mismatches.push({
      field: "epochId",
      expected: source.epoch.epochId,
      actual: restored.epoch.epochId,
    });
  }
  if (source.epoch.schemaVersion !== restored.epoch.schemaVersion) {
    mismatches.push({
      field: "schemaVersion",
      expected: source.epoch.schemaVersion,
      actual: restored.epoch.schemaVersion,
    });
  }
  for (const table of SOURCE_TABLES) {
    if (source.counts[table] === restored.counts[table]) continue;
    mismatches.push({
      field: `count:${table}`,
      expected: source.counts[table],
      actual: restored.counts[table],
    });
  }
  return mismatches;
}

function prepareEmptyDirectory(directory) {
  if (fs.existsSync(directory)) {
    if (!fs.statSync(directory).isDirectory()) {
      throw new Error(`Recovery drill target is not a directory: ${directory}`);
    }
    if (fs.readdirSync(directory).length > 0) {
      throw new Error(`Recovery drill directory must be empty: ${directory}`);
    }
    return;
  }
  fs.mkdirSync(directory, { recursive: true });
}

function requiredPath(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return path.resolve(value);
}

module.exports = {
  SOURCE_TABLES,
  runSqliteRecoveryDrill,
  snapshot,
  compareSnapshots,
};

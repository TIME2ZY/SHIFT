const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createStorage } = require("../index");
const { auditSqliteStorage } = require("./audit-storage");
const { backupDatabase, integrityCheck, rebuildDerivedModels } = require("../maintenance");

const SOURCE_TABLES = Object.freeze([
  "storage_metadata",
  "threads",
  "context_windows",
  "invocations",
  "invocation_events",
  "messages",
  "projects",
  "memory_entries",
  "memory_events",
  "legacy_memory_archive",
  "purged_threads",
  "collaboration_tasks",
  "collaboration_task_events",
  "storage_outbox",
]);

const PROJECTION_TABLES = Object.freeze([
  "recall_items",
  "recall_fts",
  "memory_search",
  "memory_search_fts",
  "thread_digests",
]);

async function runSqliteRecoveryDrill({
  sourceFile,
  drillDir,
  fullIntegrity = true,
  verifyProductApi,
} = {}) {
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
  let report;
  try {
    const restoredSnapshot = snapshot(restoredStorage);
    const integrity = integrityCheck(restoredStorage.db, { full: fullIntegrity });
    const causality = inspectCausality(restoredStorage.db);
    const projectionsBefore = projectionSnapshot(restoredStorage.db);
    const rebuilt = rebuildDerivedModels(restoredStorage);
    const projectionsAfter = projectionSnapshot(restoredStorage.db);
    const audit = auditSqliteStorage({
      storage: restoredStorage,
      fullIntegrity,
      logger: { error() {} },
    });
    const mismatches = compareSnapshots(sourceSnapshot, restoredSnapshot);
    report = {
      ok:
        integrity.ok && audit.ok && causality.ok && projectionsAfter.ok && mismatches.length === 0,
      sourceFile: source,
      drillDir: root,
      completedAt: new Date().toISOString(),
      backup: {
        file: backup.destination,
        bytes: backup.bytes,
      },
      restoredFile,
      source: sourceSnapshot,
      restored: restoredSnapshot,
      mismatches,
      integrity,
      causality,
      projections: {
        beforeRebuild: projectionsBefore,
        afterRebuild: projectionsAfter,
      },
      rebuilt,
      audit: {
        ok: audit.ok,
        summary: audit.summary,
      },
    };
  } finally {
    restoredStorage.close();
  }

  if (typeof verifyProductApi === "function") {
    report.productApi = await verifyProductApi({
      restoredFile,
      drillDir: root,
      sourceSnapshot,
    });
    report.ok = report.ok && report.productApi.ok;
  }
  const reportFile = path.join(root, "recovery-report.json");
  report.reportFile = reportFile;
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

function snapshot(storage) {
  const counts = {};
  const fingerprints = {};
  for (const table of SOURCE_TABLES) {
    const rows = storage.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    counts[table] = rows.length;
    fingerprints[table] = fingerprint(rows);
  }
  return {
    epoch: storage.metadata.getCurrent(),
    counts,
    fingerprints,
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
    if (source.counts[table] !== restored.counts[table]) {
      mismatches.push({
        field: `count:${table}`,
        expected: source.counts[table],
        actual: restored.counts[table],
      });
    }
    if (source.fingerprints[table] !== restored.fingerprints[table]) {
      mismatches.push({
        field: `fingerprint:${table}`,
        expected: source.fingerprints[table],
        actual: restored.fingerprints[table],
      });
    }
  }
  return mismatches;
}

function inspectCausality(db) {
  const checks = [
    [
      "invocation-window-thread",
      `
      SELECT COUNT(*) AS count FROM invocations i
      JOIN context_windows w ON w.id = i.window_id
      WHERE i.thread_id <> w.thread_id
    `,
    ],
    [
      "message-window-thread",
      `
      SELECT COUNT(*) AS count FROM messages m
      JOIN context_windows w ON w.id = m.window_id
      WHERE m.thread_id <> w.thread_id
    `,
    ],
    [
      "message-invocation-thread",
      `
      SELECT COUNT(*) AS count FROM messages m
      JOIN invocations i ON i.id = m.invocation_id
      WHERE m.thread_id <> i.thread_id
    `,
    ],
    [
      "invocation-parent-thread",
      `
      SELECT COUNT(*) AS count FROM invocations child
      JOIN invocations parent ON parent.id = child.parent_invocation_id
      WHERE child.thread_id <> parent.thread_id
    `,
    ],
    [
      "invocation-trigger-thread",
      `
      SELECT COUNT(*) AS count FROM invocations i
      JOIN messages m ON m.id = i.trigger_message_id
      WHERE i.thread_id <> m.thread_id
    `,
    ],
    [
      "memory-message-thread",
      `
      SELECT COUNT(*) AS count FROM memory_entries memory
      JOIN messages m ON m.id = memory.source_message_id
      WHERE COALESCE(memory.owner_thread_id, memory.origin_thread_id) IS NOT NULL
        AND COALESCE(memory.owner_thread_id, memory.origin_thread_id) <> m.thread_id
    `,
    ],
    [
      "memory-invocation-thread",
      `
      SELECT COUNT(*) AS count FROM memory_entries memory
      JOIN invocations i ON i.id = memory.source_invocation_id
      WHERE COALESCE(memory.owner_thread_id, memory.origin_thread_id) IS NOT NULL
        AND COALESCE(memory.owner_thread_id, memory.origin_thread_id) <> i.thread_id
    `,
    ],
    [
      "outbox-invocation-thread",
      `
      SELECT COUNT(*) AS count FROM storage_outbox o
      JOIN invocations i ON i.id = o.invocation_id
      WHERE o.thread_id <> i.thread_id
    `,
    ],
    [
      "thread-message-sequence",
      `
      SELECT COUNT(*) AS count FROM threads t
      WHERE t.next_message_sequence <> COALESCE(
        (SELECT MAX(m.sequence_no) + 1 FROM messages m WHERE m.thread_id = t.id), 0
      )
    `,
    ],
    [
      "invocation-event-sequence",
      `
      SELECT COUNT(*) AS count FROM invocations i
      WHERE i.next_event_sequence <> COALESCE(
        (SELECT MAX(e.sequence_no) + 1 FROM invocation_events e WHERE e.invocation_id = i.id), 0
      )
    `,
    ],
  ];
  const results = {};
  for (const [name, sql] of checks) {
    results[name] = Number(db.prepare(sql).get().count || 0);
  }
  const foreignKeyErrors = db.pragma("foreign_key_check").length;
  return {
    ok: foreignKeyErrors === 0 && Object.values(results).every((count) => count === 0),
    foreignKeyErrors,
    violations: results,
  };
}

function projectionSnapshot(db) {
  const counts = {};
  for (const table of PROJECTION_TABLES) {
    counts[table] = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count || 0);
  }
  const expected = {
    recall_fts: counts.recall_items,
    memory_search: Number(db.prepare("SELECT COUNT(*) AS count FROM memory_entries").get().count),
    memory_search_fts: counts.memory_search,
    thread_digests: Number(db.prepare("SELECT COUNT(*) AS count FROM threads").get().count),
  };
  const mismatches = [];
  for (const [table, count] of Object.entries(expected)) {
    if (counts[table] !== count) {
      mismatches.push({ table, expected: count, actual: counts[table] });
    }
  }
  return { ok: mismatches.length === 0, counts, expected, mismatches };
}

function fingerprint(rows) {
  return crypto.createHash("sha256").update(stableStringify(rows)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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
  PROJECTION_TABLES,
  runSqliteRecoveryDrill,
  snapshot,
  compareSnapshots,
  inspectCausality,
  projectionSnapshot,
};

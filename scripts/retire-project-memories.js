#!/usr/bin/env node
/**
 * Retire active project-scoped product memories.
 *
 * Product Memory is thread-only; project truth lives in docs/.
 * This script supersedes remaining active project decision/constraint/fact rows
 * so they no longer inject or search as active product memory.
 *
 * Usage:
 *   node scripts/retire-project-memories.js --dry-run
 *   node scripts/retire-project-memories.js --apply
 *   node scripts/retire-project-memories.js --apply --export docs/decisions/legacy-from-memory.md
 *   node scripts/retire-project-memories.js --db path/to/shift.sqlite --dry-run
 */

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { loadProjectEnv } = require("../src/shared/load-env");
const { DEFAULT_MEMORY_DB_FILE, ROOT } = require("../src/shared/runtime-paths");

const PRODUCT_KINDS = new Set(["decision", "constraint", "fact"]);
const BATCH_ID = `memory-thread-only-${new Date().toISOString().slice(0, 10)}`;

function parseArgs(argv) {
  const options = {
    db: null,
    dryRun: true,
    apply: false,
    exportPath: null,
    help: false,
    noBackup: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db") options.db = path.resolve(argv[++i] || "");
    else if (arg === "--dry-run") {
      options.dryRun = true;
      options.apply = false;
    } else if (arg === "--apply") {
      options.apply = true;
      options.dryRun = false;
    } else if (arg === "--export") options.exportPath = path.resolve(argv[++i] || "");
    else if (arg === "--no-backup") options.noBackup = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Retire active project-scoped product memories.

Options:
  --dry-run          List candidates only (default)
  --apply            Supersede active project product memories
  --export <path>    Write a markdown summary of retired rows
  --db <path>        SQLite path (default: data/runtime/shift.sqlite)
  --no-backup        Skip automatic .bak copy before --apply
  --help             Show this help
`);
}

function listCandidates(db) {
  return db
    .prepare(
      `
      SELECT id, kind, topic, scope, status, content, summary, origin_thread_id,
             project_key, created_by, created_at, metadata_json
      FROM memory_entries
      WHERE scope = 'project'
        AND status = 'active'
        AND kind IN ('decision', 'constraint', 'fact')
      ORDER BY created_at ASC, id ASC
    `
    )
    .all()
    .filter((row) => PRODUCT_KINDS.has(row.kind));
}

function mergeMetadata(rawJson, patch) {
  let base = {};
  if (rawJson) {
    try {
      base = JSON.parse(rawJson);
      if (!base || typeof base !== "object" || Array.isArray(base)) base = {};
    } catch {
      base = {};
    }
  }
  return { ...base, ...patch };
}

function backupDatabase(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${file}.bak-${stamp}`;
  fs.copyFileSync(file, dest);
  return dest;
}

function writeExport(filePath, rows, applied) {
  const lines = [
    "# Legacy project Memory export",
    "",
    "> Historical product memories that were stored as `scope=project`.",
    "> They are **not** adopted project decisions. Prefer formal ADRs under `docs/decisions/`.",
    "",
    `- Batch: \`${BATCH_ID}\``,
    `- Applied: ${applied ? "yes" : "dry-run"}`,
    `- Count: ${rows.length}`,
    "",
  ];
  for (const row of rows) {
    lines.push(`## ${row.kind} / ${row.topic || "(no-topic)"}`);
    lines.push("");
    lines.push(`- id: \`${row.id}\``);
    lines.push(`- origin_thread: \`${row.origin_thread_id || ""}\``);
    lines.push(`- project_key: \`${row.project_key || ""}\``);
    lines.push(`- created_at: ${row.created_at}`);
    lines.push(`- created_by: ${row.created_by || ""}`);
    lines.push("");
    lines.push(String(row.content || "").trim());
    lines.push("");
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
}

function applyRetirement(db, rows) {
  const retiredAt = new Date().toISOString();
  const update = db.prepare(`
    UPDATE memory_entries
    SET status = 'superseded',
        superseded_by = NULL,
        metadata_json = ?
    WHERE id = ? AND status = 'active' AND scope = 'project'
  `);
  const deleteSearch = db.prepare(`DELETE FROM memory_search WHERE memory_id = ?`);
  const insertEvent = db.prepare(`
    INSERT INTO memory_events (
      event_type, thread_id, project_key, memory_id, invocation_id, agent_id, payload_json, created_at
    ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)
  `);

  const tx = db.transaction(() => {
    let changed = 0;
    for (const row of rows) {
      const metadata = mergeMetadata(row.metadata_json, {
        retiredReason: "project-memory-abolished",
        retiredAt,
        retirementBatch: BATCH_ID,
      });
      const result = update.run(JSON.stringify(metadata), row.id);
      if (result.changes > 0) {
        changed += 1;
        deleteSearch.run(row.id);
        insertEvent.run(
          "memory_superseded",
          row.origin_thread_id || null,
          row.project_key || null,
          row.id,
          JSON.stringify({
            reason: "project-memory-abolished",
            batch: BATCH_ID,
            topic: row.topic || null,
            kind: row.kind,
          }),
          retiredAt
        );
      }
    }
    return changed;
  });
  return tx();
}

function main() {
  loadProjectEnv(ROOT);
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const dbFile = options.db || DEFAULT_MEMORY_DB_FILE;
  if (!fs.existsSync(dbFile)) {
    throw new Error(`Database not found: ${dbFile}`);
  }

  const db = new Database(dbFile);
  try {
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_entries'"
      )
      .get();
    if (!table) throw new Error("memory_entries table missing.");

    const rows = listCandidates(db);
    console.log(`Database: ${dbFile}`);
    console.log(`Active project product memories: ${rows.length}`);
    console.log(`Batch: ${BATCH_ID}`);
    for (const row of rows) {
      console.log(
        `- ${row.id} | ${row.kind} | ${row.topic || "-"} | origin=${row.origin_thread_id || "-"} | ${String(row.content || "").slice(0, 80)}`
      );
    }

    if (options.exportPath) {
      writeExport(options.exportPath, rows, options.apply);
      console.log(`Export written: ${options.exportPath}`);
    }

    if (options.dryRun || !options.apply) {
      console.log("Dry-run only. Re-run with --apply to retire.");
      return;
    }

    if (!options.noBackup) {
      const bak = backupDatabase(dbFile);
      console.log(`Backup: ${bak}`);
    }

    const changed = applyRetirement(db, rows);
    console.log(`Retired (superseded): ${changed}`);

    const remaining = listCandidates(db).length;
    console.log(`Remaining active project product memories: ${remaining}`);
    if (remaining !== 0) {
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
}

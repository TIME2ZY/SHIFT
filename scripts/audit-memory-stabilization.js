#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { loadProjectEnv } = require("../src/shared/load-env");
const { DEFAULT_MEMORY_DB_FILE, ROOT } = require("../src/shared/runtime-paths");
const { ENV } = require("../src/shared/brand");
const {
  analyzeMemoryStabilization,
  mapMemoryAuditRow,
} = require("../src/storage/offline/memory-stabilization");

function parseArgs(argv) {
  const options = { db: null, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") options.db = path.resolve(argv[++index] || "");
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function auditMemoryDatabase(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`Memory database does not exist: ${file}`);
  }
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_entries'"
      )
      .get();
    if (!table) throw new Error("memory_entries table does not exist.");
    const memories = db
      .prepare("SELECT * FROM memory_entries ORDER BY created_at, id")
      .all()
      .map(mapMemoryAuditRow);
    return {
      database: path.resolve(file),
      generatedAt: new Date().toISOString(),
      ...analyzeMemoryStabilization(memories),
    };
  } finally {
    db.close();
  }
}

function printReport(report) {
  console.log(
    [
      `memory-stabilization contract=${report.contractVersion}`,
      `ready=${report.readyForRetrieval ? "yes" : "no"}`,
      `total=${report.counts.total}`,
      `retrievable=${report.counts.retrievable}`,
      `isolated=${report.counts.logicallyIsolated}`,
      `review=${report.counts.qualityReview}`,
      `conflicts=${report.counts.conflicts}`,
    ].join(" ")
  );
  for (const item of report.qualityReview) {
    console.log(`  review ${item.memoryId}: ${item.issues.join(",")}`);
  }
  for (const item of report.conflicts) {
    console.log(`  conflict ${item.slot}: ${item.memoryIds.join(",")}`);
  }
}

function printHelp() {
  console.log(`Usage: node scripts/audit-memory-stabilization.js [options]

Options:
  --db <path>  authoritative Shift SQLite database
  --json       print the complete migration/isolation report
  -h, --help   show help
`);
}

function main() {
  loadProjectEnv(ROOT);
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const file = options.db || process.env[ENV.MEMORY_DB] || DEFAULT_MEMORY_DB_FILE;
  const report = auditMemoryDatabase(path.resolve(file));
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  if (!report.readyForRetrieval) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

module.exports = {
  parseArgs,
  auditMemoryDatabase,
  printReport,
};

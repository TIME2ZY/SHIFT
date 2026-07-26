#!/usr/bin/env node
/**
 * Audit SQLite L1/L2 consistency (optional --repair rebuilds recall/FTS).
 *
 * Usage:
 *   node scripts/audit-sqlite-storage.js
 *   node scripts/audit-sqlite-storage.js --repair
 *   node scripts/audit-sqlite-storage.js --db path --json
 */
const path = require("node:path");
const { DEFAULT_MEMORY_DB_FILE } = require("../src/shared/runtime-paths");
const { auditSqliteStorage } = require("../src/storage/audit-storage");

function parseArgs(argv) {
  const options = {
    memoryDbFile: DEFAULT_MEMORY_DB_FILE,
    repair: false,
    json: false,
    fullIntegrity: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repair") options.repair = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--full") options.fullIntegrity = true;
    else if (arg === "--db") options.memoryDbFile = path.resolve(argv[++i] || "");
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/audit-sqlite-storage.js [options]

Options:
  --db <path>   authoritative SQLite (default: data/runtime/shift.sqlite)
  --repair      rebuild missing recall projections / FTS drift
  --full        run full integrity_check (slower)
  --json        print full JSON report
  -h, --help    show help
`);
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    printHelp();
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    printHelp();
    return;
  }

  const report = auditSqliteStorage({
    memoryDbFile: options.memoryDbFile,
    repair: options.repair,
    fullIntegrity: options.fullIntegrity,
    logger: console,
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `audit ${report.ok ? "ok" : "failed"} findings=${report.summary.total} errors=${report.summary.errors} warnings=${report.summary.warnings}`
    );
    if (Object.keys(report.summary.byCode).length > 0) {
      console.log(
        "by code:",
        Object.entries(report.summary.byCode)
          .map(([code, count]) => `${code}=${count}`)
          .join(" ")
      );
    }
    for (const finding of report.findings.slice(0, 30)) {
      console.log(`  [${finding.severity}] ${finding.code}: ${finding.message}`);
    }
    if (report.findings.length > 30) {
      console.log(`  … ${report.findings.length - 30} more`);
    }
    if (report.repairs.length > 0) {
      console.log(`repairs: ${report.repairs.length}`);
      for (const repair of report.repairs) {
        console.log(
          `  ${repair.action}${repair.threadId ? ` ${repair.threadId}` : ""}${
            repair.error ? ` ERROR ${repair.error}` : " ok"
          }`
        );
      }
    }
  }

  if (!report.ok) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}

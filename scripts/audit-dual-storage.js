#!/usr/bin/env node
/**
 * Compare the temporary legacy file sinks with SQLite without changing data.
 *
 * Usage:
 *   node scripts/audit-dual-storage.js
 *   node scripts/audit-dual-storage.js --json
 *   node scripts/audit-dual-storage.js --db path --sessions path --transcripts path
 */
const path = require("node:path");
const {
  LEGACY_MEMORY_DB_FILE,
  DEFAULT_SESSIONS_FILE,
  DEFAULT_TRANSCRIPT_DIR,
} = require("../src/shared/runtime-paths");
const { auditDualStorage } = require("../src/storage/offline/audit-dual-storage");

function parseArgs(argv) {
  const options = {
    memoryDbFile: LEGACY_MEMORY_DB_FILE,
    sessionsFile: DEFAULT_SESSIONS_FILE,
    transcriptDir: DEFAULT_TRANSCRIPT_DIR,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--db") options.memoryDbFile = path.resolve(requiredValue(argv, ++index, arg));
    else if (arg === "--sessions")
      options.sessionsFile = path.resolve(requiredValue(argv, ++index, arg));
    else if (arg === "--transcripts")
      options.transcriptDir = path.resolve(requiredValue(argv, ++index, arg));
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a path.`);
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/audit-dual-storage.js [options]

Options:
  --db <path>           memory.sqlite (default: data/runtime/memory.sqlite)
  --sessions <path>     legacy sessions JSON (default: data/runtime/sessions.json)
  --transcripts <path>  transcript root (default: data/runtime/transcripts)
  --json                print full JSON report
  -h, --help            show help
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

  const report = auditDualStorage(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const files = report.totals.files;
    const sqlite = report.totals.sqlite;
    console.log(
      `dual audit ${report.converged ? "converged" : "diverged"}` +
        ` findings=${report.summary.total}` +
        ` errors=${report.summary.errors}` +
        ` warnings=${report.summary.warnings}`
    );
    console.log(
      `  files  threads=${files.threads} messages=${files.messages}` +
        ` invocations=${files.invocations} events=${files.events}`
    );
    console.log(
      `  sqlite threads=${sqlite.threads} messages=${sqlite.messages}` +
        ` invocations=${sqlite.invocations} events=${sqlite.events}`
    );
    console.log(
      `  coverage file→sqlite threads=${formatRate(report.metrics.fileThreadsPresentInSqlite)}` +
        ` messages=${formatRate(report.metrics.fileMessagesPresentInSqlite)}` +
        ` invocations=${formatRate(report.metrics.fileInvocationsPresentInSqlite)}` +
        ` exactEvents=${formatRate(report.metrics.mirroredInvocationsWithExactEventKinds)}`
    );
    if (Object.keys(report.summary.byCode).length > 0) {
      console.log(
        "  by code:",
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
  }

  if (!report.converged) process.exitCode = 1;
}

function formatRate(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}

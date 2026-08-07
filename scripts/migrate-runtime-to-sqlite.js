#!/usr/bin/env node
/**
 * Import sessions.json + transcript JSONL into SQLite (idempotent).
 *
 * Usage:
 *   node scripts/migrate-runtime-to-sqlite.js
 *   node scripts/migrate-runtime-to-sqlite.js --dry-run
 *   node scripts/migrate-runtime-to-sqlite.js --sessions path --transcripts path --db path
 */
const path = require("node:path");
const {
  DEFAULT_SESSIONS_FILE,
  DEFAULT_TRANSCRIPT_DIR,
  LEGACY_MEMORY_DB_FILE,
} = require("../src/shared/runtime-paths");
const { migrateRuntimeToSqlite } = require("../src/storage/offline/migrate-runtime");

function parseArgs(argv) {
  const options = {
    sessionsFile: DEFAULT_SESSIONS_FILE,
    transcriptDir: DEFAULT_TRANSCRIPT_DIR,
    memoryDbFile: LEGACY_MEMORY_DB_FILE,
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--sessions") options.sessionsFile = path.resolve(argv[++i] || "");
    else if (arg === "--transcripts") options.transcriptDir = path.resolve(argv[++i] || "");
    else if (arg === "--db") options.memoryDbFile = path.resolve(argv[++i] || "");
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/migrate-runtime-to-sqlite.js [options]

Options:
  --sessions <path>      sessions.json (default: data/runtime/sessions.json)
  --transcripts <path>   transcript root (default: data/runtime/transcripts)
  --db <path>            legacy validation target (default: data/runtime/memory.sqlite)
  --dry-run              report diffs without writing
  --json                 print full JSON report
  -h, --help             show help
`);
}

async function main() {
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

  const report = await migrateRuntimeToSqlite({
    sessionsFile: options.sessionsFile,
    transcriptDir: options.transcriptDir,
    memoryDbFile: options.memoryDbFile,
    dryRun: options.dryRun,
    logger: console,
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      [
        `migrate ${options.dryRun ? "(dry-run) " : ""}complete`,
        `threads=${report.totals.threads}`,
        `messages+${report.totals.messagesImported}/skip=${report.totals.messagesSkipped}`,
        `events+${report.totals.eventsImported}/skip=${report.totals.eventsSkipped}`,
        `invocations+${report.totals.invocationsCreated}`,
        `memories+${report.totals.memoriesImported}`,
        `recallRebuilt=${report.totals.recallRebuilt}`,
        report.integrity ? `integrity=${report.integrity.ok ? "ok" : "fail"}` : null,
      ]
        .filter(Boolean)
        .join(" ")
    );
    for (const thread of report.threads) {
      const summary = thread.diffs.find(
        (item) => item.kind === "summary" || item.kind === "preview"
      );
      if (!summary) continue;
      console.log(
        `  thread ${thread.threadId}: msg+${thread.messagesImported} evt+${thread.eventsImported} inv+${thread.invocationsCreated}`
      );
    }
    if (report.skipped.length > 0) {
      console.log(`skipped: ${report.skipped.map((item) => item.threadId).join(", ")}`);
    }
  }

  if (report.integrity && !report.integrity.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

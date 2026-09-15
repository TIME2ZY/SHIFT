#!/usr/bin/env node
/**
 * Close tool spans that a crashed SHIFT process left without a tool.finished.
 *
 * These are the rows behind the `span_missing_end` health alert: the
 * invocation reached a terminal state on the next reconcile, but nothing ever
 * closed its in-flight tools. Current builds close them in the same
 * transaction as the terminal state, so on a current database this reports
 * zero candidates and does nothing.
 *
 * Usage:
 *   node scripts/repair-dangling-tool-spans.js --dry-run
 *   node scripts/repair-dangling-tool-spans.js --apply
 *   node scripts/repair-dangling-tool-spans.js --db path/to/shift.sqlite --dry-run
 */

const path = require("node:path");
const { loadProjectEnv } = require("../src/shared/load-env");
const { DEFAULT_MEMORY_DB_FILE, ROOT } = require("../src/shared/runtime-paths");
const { createStorage } = require("../src/storage");
const {
  listDanglingToolSpans,
  repairDanglingToolSpans,
} = require("../src/storage/offline/dangling-tool-span-repair");

function parseArgs(argv) {
  const options = { db: null, dryRun: true, apply: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db") options.db = path.resolve(argv[++i] || "");
    else if (arg === "--dry-run") {
      options.dryRun = true;
      options.apply = false;
    } else if (arg === "--apply") {
      options.apply = true;
      options.dryRun = false;
    } else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Close tool spans left open by a crashed SHIFT process.

Options:
  --dry-run       List dangling spans only (default)
  --apply         Append a synthetic tool.finished for each dangling span
  --db <path>     SQLite path (default: data/runtime/shift.sqlite)
  --help          Show this help
`);
}

function main() {
  loadProjectEnv(ROOT);
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const dbFile = options.db || DEFAULT_MEMORY_DB_FILE;
  const storage = createStorage({ file: dbFile });
  try {
    const candidates = listDanglingToolSpans(storage);
    console.log(`Database: ${dbFile}`);
    console.log(`Invocations with dangling tool spans: ${candidates.length}`);
    for (const candidate of candidates) {
      for (const tool of candidate.tools) {
        console.log(
          `- ${candidate.invocationId} | ${candidate.agentId} | ${candidate.state} | ` +
            `tool=${tool.toolName || "?"} (${tool.toolId}) | started=${tool.startedAt}`
        );
      }
    }

    if (options.dryRun || !options.apply) {
      console.log("Dry-run only. Re-run with --apply to close these spans.");
      return;
    }

    const report = repairDanglingToolSpans({ storage, dryRun: false });
    console.log(`Closed tool spans: ${report.repaired.reduce((n, r) => n + r.closed, 0)}`);
    if (report.remaining !== 0) {
      console.log(`Still dangling after repair: ${report.remaining}`);
      process.exitCode = 1;
    }
  } finally {
    storage.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
}

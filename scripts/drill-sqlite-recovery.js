#!/usr/bin/env node
const path = require("node:path");
const { DEFAULT_MEMORY_DB_FILE } = require("../src/shared/runtime-paths");
const { runSqliteRecoveryDrill } = require("../src/storage/offline/recovery-drill");
const { verifyRestoredSqliteApi } = require("../src/server/recovery-verification");

function parseArgs(argv) {
  const options = {
    sourceFile: DEFAULT_MEMORY_DB_FILE,
    drillDir: "",
    json: false,
    fullIntegrity: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db") options.sourceFile = path.resolve(argv[++i] || "");
    else if (arg === "--dir") options.drillDir = path.resolve(argv[++i] || "");
    else if (arg === "--json") options.json = true;
    else if (arg === "--quick") options.fullIntegrity = false;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/drill-sqlite-recovery.js --dir <empty-directory> [options]

Options:
  --db <path>   source authoritative SQLite (default: data/runtime/shift.sqlite)
  --dir <path>  required empty directory for backup and restored database
  --quick       skip full integrity_check
  --json        print the complete recovery report
  -h, --help    show help
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
  if (!options.drillDir) {
    console.error("--dir is required and must name an empty directory.");
    printHelp();
    process.exitCode = 2;
    return;
  }

  const report = await runSqliteRecoveryDrill({
    ...options,
    verifyProductApi: verifyRestoredSqliteApi,
  });
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `recovery drill ${report.ok ? "ok" : "failed"} source=${report.sourceFile} restored=${report.restoredFile}`
    );
    console.log(
      `backup bytes=${report.backup.bytes} epoch=${report.restored.epoch.epochId} schema=${report.restored.epoch.schemaVersion}`
    );
    console.log(
      `integrity=${report.integrity.ok ? "ok" : "failed"} audit=${report.audit.ok ? "ok" : "failed"} mismatches=${report.mismatches.length}`
    );
    console.log(
      `causality=${report.causality.ok ? "ok" : "failed"} projections=${report.projections.afterRebuild.ok ? "ok" : "failed"} api=${report.productApi.ok ? "ok" : "failed"}`
    );
    console.log(`report=${report.reportFile}`);
  }
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

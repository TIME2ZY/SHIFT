#!/usr/bin/env node
const path = require("node:path");

const { loadProjectEnv } = require("../src/shared/load-env");

const ROOT = path.resolve(__dirname, "..");
loadProjectEnv(ROOT);

const { createRuntimePaths } = require("../src/shared/runtime-paths");
const { LEGACY_DATABASE_FILE } = require("../src/storage/offline/legacy-runtime-paths");
const { migrateRuntimeHome } = require("../src/storage/offline/runtime-home");

function parseArgs(argv) {
  const options = { sourceFile: LEGACY_DATABASE_FILE, projectDir: ROOT, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source") options.sourceFile = path.resolve(argv[++i] || "");
    else if (arg === "--project-dir") options.projectDir = path.resolve(argv[++i] || "");
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/migrate-storage-home.js [options]

Performs the one-time verified migration into SHIFT_HOME/data/shift.sqlite.
Stop the SHIFT server before running this command.

Options:
  --source <path>       legacy source database (default: repository data/runtime/shift.sqlite)
  --project-dir <path>  project that owns every existing thread (default: SHIFT repository)
  --json                print the complete migration report
  -h, --help            show help
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const result = await migrateRuntimeHome({
    runtimePaths: createRuntimePaths(),
    sourceFile: options.sourceFile,
    projectDir: options.projectDir,
  });
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else if (result.alreadyMigrated) {
    console.log(`SHIFT storage was already migrated: ${result.target}`);
  } else {
    console.log(
      `SHIFT storage migrated source=${result.source} target=${result.target} manifest=${result.manifestFile}`
    );
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

#!/usr/bin/env node
const path = require("node:path");

const { loadProjectEnv } = require("../src/shared/load-env");

const ROOT = path.resolve(__dirname, "..");
loadProjectEnv(ROOT);

const { createRuntimePaths } = require("../src/shared/runtime-paths");
const { initializeRuntimeHome } = require("../src/storage/offline/runtime-home");

function parseArgs(argv) {
  const options = { json: false, cutoverTime: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--cutover-time") options.cutoverTime = argv[++i] || "";
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/init-storage-home.js [options]

Creates a brand-new active clean epoch at SHIFT_HOME/data/shift.sqlite.
The target database and sidecars must not already exist.

Options:
  --cutover-time <ISO>  optional explicit cutover timestamp
  --json                print the complete result
  -h, --help            show help
`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const result = initializeRuntimeHome({
    runtimePaths: createRuntimePaths(),
    cutoverTime: options.cutoverTime,
  });
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(
      `SHIFT storage initialized file=${result.file} epoch=${result.epoch.epochId} cutover=${result.epoch.cutoverTime}`
    );
  }
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}

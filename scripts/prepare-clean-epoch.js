#!/usr/bin/env node
const path = require("node:path");
const { prepareCleanEpoch } = require("../src/storage/offline/clean-epoch");

function parseArgs(argv) {
  const options = { file: "", cutoverTime: undefined, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db") options.file = path.resolve(argv[++i] || "");
    else if (arg === "--cutover-time") options.cutoverTime = argv[++i] || "";
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/prepare-clean-epoch.js --db <new-file> [options]

Creates and activates a brand-new empty SQLite storage epoch.
The target database and its WAL/SHM sidecars must not already exist.

Options:
  --db <path>             required new SQLite file
  --cutover-time <ISO>    optional explicit cutover timestamp
  --json                  print the complete result
  -h, --help              show help
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
  if (!options.file) {
    console.error("--db is required.");
    printHelp();
    process.exitCode = 2;
    return;
  }

  const result = prepareCleanEpoch(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `clean epoch ready file=${result.file} epoch=${result.epoch.epochId} schema=${result.epoch.schemaVersion} cutover=${result.epoch.cutoverTime}`
    );
  }
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}

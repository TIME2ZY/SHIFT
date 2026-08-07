#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { executeLegacyCleanup } = require("../src/storage/offline/legacy-cleanup-executor");

function parseArgs(argv) {
  const options = { manifestFile: "", confirmation: "", apply: false, receipt: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--manifest") options.manifestFile = path.resolve(argv[++i] || "");
    else if (arg === "--confirm") options.confirmation = argv[++i] || "";
    else if (arg === "--receipt") options.receipt = path.resolve(argv[++i] || "");
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/execute-legacy-cleanup.js --manifest <file> --confirm <token> [options]

Validates a versioned cleanup manifest. Deletion occurs only with --apply.

Options:
  --manifest <path>  final cleanup manifest generated after archival coverage
  --confirm <token>  exact confirmation token printed in the manifest
  --apply            permanently delete only allowlisted manifest targets
  --receipt <path>   save the validation/deletion report
  -h, --help         show help
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
  try {
    const report = executeLegacyCleanup(options);
    const json = JSON.stringify(report, null, 2);
    if (options.receipt) {
      fs.mkdirSync(path.dirname(options.receipt), { recursive: true });
      fs.writeFileSync(options.receipt, `${json}\n`, "utf8");
    }
    console.log(json);
  } catch (error) {
    console.error(`Legacy cleanup blocked: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { main, parseArgs };

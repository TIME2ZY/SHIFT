#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const {
  buildLegacyCleanupManifest,
  readEpochMetadata,
} = require("../src/storage/legacy-cleanup-manifest");
const runtimePaths = require("../src/shared/runtime-paths");

function parseArgs(argv) {
  const options = {
    memoryDbFile: runtimePaths.DEFAULT_MEMORY_DB_FILE,
    sessionsFile: runtimePaths.DEFAULT_SESSIONS_FILE,
    invocationsFile: runtimePaths.DEFAULT_INVOCATIONS_FILE,
    transcriptDir: runtimePaths.DEFAULT_TRANSCRIPT_DIR,
    sessionMapRoot: runtimePaths.DEFAULT_SESSION_MAP_ROOT,
    output: "",
  };
  const names = new Map([
    ["--db", "memoryDbFile"],
    ["--sessions", "sessionsFile"],
    ["--invocations", "invocationsFile"],
    ["--transcripts", "transcriptDir"],
    ["--session-maps", "sessionMapRoot"],
    ["--output", "output"],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (names.has(arg)) options[names.get(arg)] = path.resolve(argv[++i] || "");
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/plan-legacy-cleanup.js [options]

Creates a read-only cleanup manifest. It never deletes data.

Options:
  --db <path>            SQLite database to inspect
  --sessions <path>      legacy sessions JSON
  --invocations <path>   legacy invocation registry
  --transcripts <path>   legacy transcript directory
  --session-maps <path>  legacy provider session maps
  --output <path>        optionally save the JSON report
  -h, --help             show help
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

  const epoch = readEpochMetadata(options.memoryDbFile);
  const manifest = buildLegacyCleanupManifest({ paths: options, epoch });
  const json = JSON.stringify(manifest, null, 2);
  if (options.output) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${json}\n`, "utf8");
  }
  console.log(json);
}

main();

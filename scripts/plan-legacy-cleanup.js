#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const {
  buildLegacyCleanupManifest,
  readEpochMetadata,
} = require("../src/storage/legacy-cleanup-manifest");
const { ENV } = require("../src/shared/brand");
const { loadProjectEnv } = require("../src/shared/load-env");
const runtimePaths = require("../src/shared/runtime-paths");

function defaultOptions(env = process.env) {
  return {
    authoritativeDbFile: path.resolve(
      env[ENV.MEMORY_DB] || runtimePaths.DEFAULT_MEMORY_DB_FILE
    ),
    legacyDbFile: runtimePaths.LEGACY_MEMORY_DB_FILE,
    sessionsFile: runtimePaths.DEFAULT_SESSIONS_FILE,
    invocationsFile: runtimePaths.DEFAULT_INVOCATIONS_FILE,
    transcriptDir: path.resolve(
      env[ENV.TRANSCRIPT_DIR] || runtimePaths.DEFAULT_TRANSCRIPT_DIR
    ),
    auditTranscriptDir: path.resolve(
      env[ENV.AUDIT_TRANSCRIPT_DIR] || runtimePaths.DEFAULT_AUDIT_TRANSCRIPT_DIR
    ),
    sessionMapRoot: runtimePaths.DEFAULT_SESSION_MAP_ROOT,
    output: "",
  };
}

function parseArgs(argv, env = process.env) {
  const options = defaultOptions(env);
  const names = new Map([
    ["--db", "authoritativeDbFile"],
    ["--authoritative-db", "authoritativeDbFile"],
    ["--legacy-db", "legacyDbFile"],
    ["--sessions", "sessionsFile"],
    ["--invocations", "invocationsFile"],
    ["--transcripts", "transcriptDir"],
    ["--audit-transcripts", "auditTranscriptDir"],
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
  --authoritative-db <path>
                         active SQLite truth source used for epoch/cutover metadata
  --db <path>            backward-compatible alias for --authoritative-db
  --legacy-db <path>     pre-cutover SQLite validation database to inventory
  --sessions <path>      legacy sessions JSON
  --invocations <path>   legacy invocation registry
  --transcripts <path>   legacy transcript directory
  --audit-transcripts <path>
                         protected post-cutover canonical JSONL directory
  --session-maps <path>  legacy provider session maps
  --output <path>        optionally save the JSON report
  -h, --help             show help
`);
}

function main() {
  loadProjectEnv(runtimePaths.ROOT);
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
    const epoch = readEpochMetadata(options.authoritativeDbFile);
    const manifest = buildLegacyCleanupManifest({ paths: options, epoch });
    const json = JSON.stringify(manifest, null, 2);
    if (options.output) {
      fs.mkdirSync(path.dirname(options.output), { recursive: true });
      fs.writeFileSync(options.output, `${json}\n`, "utf8");
    }
    console.log(json);
  } catch (error) {
    console.error(`Cleanup planning blocked: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { defaultOptions, main, parseArgs };

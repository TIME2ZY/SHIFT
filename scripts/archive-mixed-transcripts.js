#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { archiveMixedCanonicalEvents } = require("../src/storage/mixed-transcript-retirement");
const { ENV } = require("../src/shared/brand");
const { loadProjectEnv } = require("../src/shared/load-env");
const runtimePaths = require("../src/shared/runtime-paths");

function parseArgs(argv, env = process.env) {
  const options = {
    authoritativeDbFile: path.resolve(
      env[ENV.MEMORY_DB] || runtimePaths.DEFAULT_MEMORY_DB_FILE
    ),
    transcriptDir: path.resolve(
      env[ENV.TRANSCRIPT_DIR] || runtimePaths.DEFAULT_TRANSCRIPT_DIR
    ),
    auditTranscriptDir: path.resolve(
      env[ENV.AUDIT_TRANSCRIPT_DIR] || runtimePaths.DEFAULT_AUDIT_TRANSCRIPT_DIR
    ),
    apply: false,
    output: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db") options.authoritativeDbFile = path.resolve(argv[++i] || "");
    else if (arg === "--transcripts") options.transcriptDir = path.resolve(argv[++i] || "");
    else if (arg === "--audit-transcripts")
      options.auditTranscriptDir = path.resolve(argv[++i] || "");
    else if (arg === "--output") options.output = path.resolve(argv[++i] || "");
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/archive-mixed-transcripts.js [options]

Plans or applies idempotent archival of canonical events found in legacy transcripts.
This command only appends verified events to the protected epoch audit archive.

Options:
  --db <path>                 active authoritative SQLite
  --transcripts <path>        mixed legacy transcript directory
  --audit-transcripts <path>  protected canonical audit root
  --apply                     append missing verified events
  --output <path>             save JSON report
  -h, --help                  show help
`);
}

async function main() {
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
    const report = await archiveMixedCanonicalEvents(options);
    const json = JSON.stringify(report, null, 2);
    if (options.output) {
      fs.mkdirSync(path.dirname(options.output), { recursive: true });
      fs.writeFileSync(options.output, `${json}\n`, "utf8");
    }
    console.log(json);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`Mixed transcript archival blocked: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

module.exports = { main, parseArgs };

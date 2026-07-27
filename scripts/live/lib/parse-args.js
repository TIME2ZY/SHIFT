/**
 * Minimal CLI argv parser for live runners.
 */

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    mode: "attach",
    capacity: 50_000,
    maxFillTurns: 12,
    turnTimeoutMs: 15 * 60 * 1000,
    totalTimeoutMs: 120 * 60 * 1000,
    strictMemory: false,
    requireSeal: false,
    dryRun: false,
    dumpDir: "",
    projectDir: "",
    sessionId: "",
    startFrom: "",
    chatRetries: 3,
    apiUrl: process.env.SHIFT_API_URL || "http://127.0.0.1:8787",
    uiToken: process.env.SHIFT_UI_TOKEN || "",
    basePort: Number(process.env.PORT || 8787),
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      return argv[i];
    };

    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (arg === "--strict-memory") {
      opts.strictMemory = true;
      continue;
    }
    if (arg === "--require-seal") {
      opts.requireSeal = true;
      continue;
    }
    if (arg === "--mode") {
      opts.mode = String(next() || "attach");
      continue;
    }
    if (arg.startsWith("--mode=")) {
      opts.mode = arg.slice("--mode=".length);
      continue;
    }
    if (arg === "--capacity") {
      opts.capacity = positiveInt(next(), opts.capacity);
      continue;
    }
    if (arg.startsWith("--capacity=")) {
      opts.capacity = positiveInt(arg.slice("--capacity=".length), opts.capacity);
      continue;
    }
    if (arg === "--max-turns" || arg === "--max-fill-turns") {
      opts.maxFillTurns = positiveInt(next(), opts.maxFillTurns);
      continue;
    }
    if (arg.startsWith("--max-turns=") || arg.startsWith("--max-fill-turns=")) {
      const raw = arg.includes("=") ? arg.split("=")[1] : "";
      opts.maxFillTurns = positiveInt(raw, opts.maxFillTurns);
      continue;
    }
    if (arg === "--turn-timeout-ms") {
      opts.turnTimeoutMs = positiveInt(next(), opts.turnTimeoutMs);
      continue;
    }
    if (arg.startsWith("--turn-timeout-ms=")) {
      opts.turnTimeoutMs = positiveInt(arg.slice("--turn-timeout-ms=".length), opts.turnTimeoutMs);
      continue;
    }
    if (arg === "--dump-dir") {
      opts.dumpDir = String(next() || "");
      continue;
    }
    if (arg.startsWith("--dump-dir=")) {
      opts.dumpDir = arg.slice("--dump-dir=".length);
      continue;
    }
    if (arg === "--project-dir") {
      opts.projectDir = String(next() || "");
      continue;
    }
    if (arg.startsWith("--project-dir=")) {
      opts.projectDir = arg.slice("--project-dir=".length);
      continue;
    }
    if (arg === "--session-id") {
      opts.sessionId = String(next() || "");
      continue;
    }
    if (arg.startsWith("--session-id=")) {
      opts.sessionId = arg.slice("--session-id=".length);
      continue;
    }
    if (arg === "--start-from") {
      opts.startFrom = String(next() || "");
      continue;
    }
    if (arg.startsWith("--start-from=")) {
      opts.startFrom = arg.slice("--start-from=".length);
      continue;
    }
    if (arg === "--chat-retries") {
      opts.chatRetries = positiveInt(next(), opts.chatRetries);
      continue;
    }
    if (arg.startsWith("--chat-retries=")) {
      opts.chatRetries = positiveInt(arg.slice("--chat-retries=".length), opts.chatRetries);
      continue;
    }
    if (arg === "--api-url") {
      opts.apiUrl = String(next() || opts.apiUrl);
      continue;
    }
    if (arg.startsWith("--api-url=")) {
      opts.apiUrl = arg.slice("--api-url=".length);
      continue;
    }
    if (arg === "--ui-token") {
      opts.uiToken = String(next() || "");
      continue;
    }
    if (arg.startsWith("--ui-token=")) {
      opts.uiToken = arg.slice("--ui-token=".length);
      continue;
    }
    if (arg === "--port") {
      opts.basePort = positiveInt(next(), opts.basePort);
      continue;
    }
    if (arg.startsWith("--port=")) {
      opts.basePort = positiveInt(arg.slice("--port=".length), opts.basePort);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!["attach", "spawn"].includes(opts.mode)) {
    throw new Error(`--mode must be attach|spawn, got "${opts.mode}"`);
  }

  if (process.env.SHIFT_LIVE_CAPACITY) {
    opts.capacity = positiveInt(process.env.SHIFT_LIVE_CAPACITY, opts.capacity);
  }

  return opts;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function printHelp() {
  console.log(`
Usage: node scripts/live/run-solo-grok.js [options]

Real multi-turn Grok conversation against the live SHIFT server (same runtime DB).
NOT part of npm test.

Options:
  --mode attach|spawn     attach = HTTP client to running server (default)
                          spawn  = start server with default runtime paths
  --capacity <n>          SHIFT_TEST_CAPACITY (default 50000). Spawn sets it;
                          attach expects the server to already use this value.
  --api-url <url>         attach base URL (default SHIFT_API_URL or http://127.0.0.1:8787)
  --ui-token <token>      UI token (default SHIFT_UI_TOKEN)
  --project-dir <path>    session project dir (default repo root)
  --session-id <id>       continue an existing session
  --start-from <turnId>   skip stack turns before this id (e.g. u9_security)
  --chat-retries <n>      retry chat on SQLITE busy / 5xx (default 3)
  --max-fill-turns <n>    max stack turns before recall (default 12)
  --turn-timeout-ms <n>   per-turn timeout (default 15min)
  --require-seal          fail if no sealed event
  --strict-memory         fail if soft memory expectations miss
  --dump-dir <path>       report directory (default output/live/solo-grok-<ts>)
  --dry-run               preflight + print turns only
  -h, --help

Env:
  SHIFT_TEST_CAPACITY / SHIFT_LIVE_CAPACITY
  SHIFT_UI_TOKEN, SHIFT_API_URL
  XAI_API_KEY, INVOKE_CLI_PROXY (same as normal Grok use)
`);
}

module.exports = { parseArgs, printHelp };

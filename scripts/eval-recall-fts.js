#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStorage } = require("../src/storage");
const { createRecallService } = require("../src/storage/recall-service");
const {
  evaluateRecallCases,
  evaluateRecallGate,
  validateLabeledRecallDataset,
} = require("../src/storage/offline/labeled-recall-eval");

const DEFAULT_CASES = path.resolve(__dirname, "../evals/recall-fts/cases.json");

function parseArgs(argv) {
  const options = { cases: DEFAULT_CASES, json: false, limit: 10 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cases") options.cases = path.resolve(argv[++index] || "");
    else if (arg === "--limit") options.limit = Number(argv[++index]);
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 30) {
    throw new Error("--limit must be an integer from 1 to 30.");
  }
  return options;
}

function loadCases(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  return validateLabeledRecallDataset(value);
}

function seedCorpus(storage, root) {
  const alphaDir = path.join(root, "alpha");
  const otherDir = path.join(root, "other");
  fs.mkdirSync(alphaDir, { recursive: true });
  fs.mkdirSync(otherDir, { recursive: true });
  storage.threads.create({ id: "alpha-a", projectDir: alphaDir });
  storage.threads.create({ id: "alpha-b", projectDir: alphaDir });
  storage.threads.create({ id: "other-a", projectDir: otherDir });

  const write = (input) =>
    storage.memory.createProduct({
      createdBy: "agent:eval",
      writeChannel: "agent",
      ...input,
    });
  write({
    id: "memory-storage-old",
    threadId: "alpha-a",
    kind: "decision",
    topic: "storage.authoritative",
    content: "在线读写曾计划使用 PostgreSQL 作为权威存储。",
    createdAt: "2026-07-01T00:00:00.000Z",
  });
  write({
    id: "memory-storage-current",
    threadId: "alpha-a",
    kind: "decision",
    topic: "storage.authoritative",
    content: "在线读写以 SQLite 为权威存储，PostgreSQL 未采用。",
    createdAt: "2026-07-02T00:00:00.000Z",
  });
  write({
    id: "memory-auth-expiry",
    threadId: "alpha-b",
    kind: "constraint",
    topic: "auth.token-expiry",
    content: "Auth token 过期必须返回 AUTH_EXPIRED，TTL 固定为 15 分钟。",
  });
  write({
    id: "memory-debug-port",
    threadId: "alpha-a",
    kind: "fact",
    topic: "runtime.debug-port",
    content: "当前 thread 的调试端口为 9999。",
    scope: "thread",
  });
  write({
    id: "memory-other-storage",
    threadId: "other-a",
    kind: "decision",
    topic: "storage.authoritative",
    content: "另一个项目以 SQLite 作为权威存储。",
  });
}

async function run(options) {
  const cases = loadCases(options.cases);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shift-recall-eval-"));
  const storage = createStorage({ file: ":memory:" });
  try {
    seedCorpus(storage, root);
    const service = createRecallService({
      storage,
      logger: { error() {}, info() {} },
    });
    const results = [];
    for (const item of cases) {
      const started = Date.now();
      const result = await service.searchForAgent(
        {
          threadId: item.threadId,
          invocationId: `eval:${item.id}`,
          caller: "debug",
        },
        {
          query: item.query,
          layers: ["memory"],
          limit: options.limit,
        }
      );
      results.push({
        id: item.id,
        hits: result.hits,
        latencyMs: Date.now() - started,
      });
    }
    const report = evaluateRecallCases(cases, results, { limit: options.limit });
    const gate = evaluateRecallGate(report);
    const latencies = results.map((item) => item.latencyMs).sort((a, b) => a - b);
    report.metrics.latencyP50Ms = percentile(latencies, 0.5);
    report.metrics.latencyP95Ms = percentile(latencies, 0.95);
    return { report, gate };
  } finally {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function printHelp() {
  console.log(`Usage: node scripts/eval-recall-fts.js [options]

Options:
  --cases <json>  alternate recall case set
  --limit <n>     result cutoff, default 10
  --json          print the complete report
  -h, --help      show help
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  const output = await run(options);
  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    const metrics = output.report.metrics;
    console.log(
      [
        `recall-fts-eval passed=${output.gate.passed ? "yes" : "no"}`,
        `cases=${metrics.cases}`,
        `recall@${options.limit}=${metrics.recallAtK.toFixed(3)}`,
        `mrr=${metrics.mrr.toFixed(3)}`,
        `ndcg@${options.limit}=${metrics.ndcgAtK.toFixed(3)}`,
        `scopeLeakage=${metrics.scopeLeakageRate.toFixed(3)}`,
        `superseded=${metrics.supersededRecallRate.toFixed(3)}`,
        `p50=${metrics.latencyP50Ms}ms`,
        `p95=${metrics.latencyP95Ms}ms`,
      ].join(" ")
    );
    for (const failure of output.report.failures) {
      console.log(`  ${failure.id}: ${failure.reason}`);
    }
  }
  if (!output.gate.passed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}

module.exports = {
  DEFAULT_CASES,
  parseArgs,
  loadCases,
  seedCorpus,
  run,
  percentile,
};

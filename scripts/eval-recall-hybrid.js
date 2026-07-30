#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { loadProjectEnv } = require("../src/shared/load-env");
const { ROOT } = require("../src/shared/runtime-paths");
const { createStorage } = require("../src/storage");
const { createEmbeddingRuntime } = require("../src/storage/embedding-runtime");
const { createRecallService } = require("../src/storage/recall-service");

loadProjectEnv(ROOT);

const CASES_FILE = path.resolve(__dirname, "../evals/recall-hybrid/cases.json");
const LIMIT = 3;

function loadCases(file = CASES_FILE) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value?.version !== 1 || !Array.isArray(value.queries)) {
    throw new Error("Hybrid recall cases must use version 1 and contain queries.");
  }
  return value.queries;
}

function seed(storage) {
  storage.threads.create({ id: "hybrid-thread" });
  const rows = [
    ["memory-storage", "decision", "storage-authority", "在线读写以 SQLite 为权威存储。"],
    ["memory-auth", "constraint", "auth-expiry", "Auth token 的 TTL 固定为十五分钟。"],
    ["memory-cache", "decision", "cache-policy", "缓存淘汰策略采用最近最少使用算法。"],
    ["memory-port", "fact", "debug-port", "当前调试端口为 9999。"],
  ];
  for (const [id, kind, topic, content] of rows) {
    storage.memory.createProduct({
      id,
      threadId: "hybrid-thread",
      kind,
      topic,
      content,
      scope: "thread",
      createdBy: "agent:eval",
      writeChannel: "agent",
    });
  }
}

function idsFromAgentResult(result) {
  return result.hits.map((hit) => hit.source.memoryId || hit.source.sourceId);
}

function reciprocalRank(ids, expected) {
  const index = ids.slice(0, LIMIT).indexOf(expected);
  return index < 0 ? 0 : 1 / (index + 1);
}

function summarize(cases, rankings) {
  const reciprocalRanks = cases.map((item, index) =>
    reciprocalRank(rankings[index] || [], item.expected)
  );
  return {
    recallAt3: reciprocalRanks.filter((value) => value > 0).length / cases.length,
    mrr: reciprocalRanks.reduce((sum, value) => sum + value, 0) / cases.length,
  };
}

async function run() {
  const cases = loadCases();
  const storage = createStorage({ file: ":memory:" });
  const runtime = createEmbeddingRuntime({
    storage,
    autoStart: false,
    logger: console,
  });
  try {
    if (!runtime.available) {
      throw new Error(`Embedding runtime unavailable: ${runtime.reason}`);
    }
    seed(storage);
    const backfill = { ready: 0, failed: 0 };
    while (true) {
      const batch = await runtime.runOnce();
      backfill.ready += batch.ready || 0;
      backfill.failed += batch.failed || 0;
      if (!batch.claimed) break;
      if (batch.failed && !batch.ready) {
        throw new Error(`Embedding eval backfill failed: ${batch.reason || "unknown"}`);
      }
    }
    const ftsService = createRecallService({
      storage,
      logger: { error() {}, info() {} },
    });
    const hybridService = createRecallService({
      storage,
      embeddingRuntime: runtime,
      logger: { error() {}, info() {} },
    });
    const rankings = { ftsOnly: [], vectorOnly: [], hybrid: [] };
    const details = [];
    for (const item of cases) {
      const context = {
        threadId: "hybrid-thread",
        invocationId: `hybrid-eval:${item.id}`,
      };
      const fts = idsFromAgentResult(
        await ftsService.searchForAgent(context, {
          query: item.query,
          layers: ["memory"],
          limit: LIMIT,
        })
      );
      const vectorResult = await runtime.search(item.query, ["thread:hybrid-thread"], LIMIT);
      const vector = vectorResult.hits.map(
        (hit) => storage.embeddings.get(Number(hit.itemId)).sourceId
      );
      const hybrid = idsFromAgentResult(
        await hybridService.searchForAgent(context, {
          query: item.query,
          layers: ["memory"],
          limit: LIMIT,
        })
      );
      rankings.ftsOnly.push(fts);
      rankings.vectorOnly.push(vector);
      rankings.hybrid.push(hybrid);
      details.push({
        id: item.id,
        query: item.query,
        expected: item.expected,
        ftsOnly: fts,
        vectorOnly: vector,
        hybrid,
      });
    }
    const metrics = Object.fromEntries(
      Object.entries(rankings).map(([name, values]) => [name, summarize(cases, values)])
    );
    const passed =
      metrics.hybrid.recallAt3 > metrics.ftsOnly.recallAt3 &&
      metrics.hybrid.mrr > metrics.ftsOnly.mrr &&
      metrics.hybrid.recallAt3 >= metrics.vectorOnly.recallAt3;
    return {
      passed,
      model: runtime.provider.model,
      dimensions: runtime.provider.dimensions,
      cases: cases.length,
      backfill,
      metrics,
      details,
    };
  } finally {
    await runtime.close();
    storage.close();
  }
}

async function main() {
  const result = await run();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`recall-hybrid-eval: ${error.message}\n`);
    process.exitCode = 2;
  });
}

module.exports = { CASES_FILE, loadCases, summarize, run };

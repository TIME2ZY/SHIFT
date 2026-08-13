#!/usr/bin/env node

const path = require("node:path");
const { parseArgs, printHelp } = require("./lib/parse-args");
const { preflight, printPreflight } = require("./lib/preflight");
const { startHarness, resolveProjectDir } = require("./lib/harness");
const { createDumpDir, writeJson, writeReport } = require("./lib/live-dump");
const { findEvents } = require("./lib/sse");
const {
  evaluateObservabilitySnapshot,
  compareRestartSnapshots,
} = require("./lib/observability-audit");

const PROMPT = [
  "这是一次 SHIFT Trace 真实链路验收，不修改仓库。",
  "请分析：本地多 Agent 系统应如何区分调度成功、执行成功与业务成功？",
  "给出简短结论后，行首 @Codex，并附完整 ```handoff，字段包含 what/why/next_action/evidence。",
  "请让 Codex复核该结论并给最终答复。",
].join("");

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return printHelp();
  opts.mode = "spawn";
  const pf = await preflight(opts);
  printPreflight(pf);
  if (!pf.ok) process.exitCode = 2;
  if (!pf.ok || opts.dryRun) return;

  const dumpDir = createDumpDir(opts.dumpDir, "observability-acceptance");
  let harness = null;
  let restarted = null;
  let sessionId = "";
  const startedAt = Date.now();
  try {
    harness = await startHarness(opts, { dumpDir });
    const project = await harness.api.openProject(resolveProjectDir(opts));
    const session = await harness.api.createSession(project.projectKey);
    sessionId = session.id;

    const chat = await harness.api.chat({
      sessionId,
      agent: "grok",
      prompt: PROMPT,
      timeoutMs: opts.turnTimeoutMs,
    });
    writeJson(path.join(dumpDir, "chat.json"), {
      status: chat.status,
      ok: chat.ok,
      summary: chat.summary,
      assistantText: chat.assistantText,
    });
    if (!chat.ok) throw new Error(`real handoff chat failed (${chat.status})`);

    const expectedInvocationIds = findEvents(chat.events, "agent-start")
      .map((event) => event.data?.invocationId)
      .filter(Boolean);
    const traces = await harness.api.listTraces(sessionId);
    const health = await harness.api.health();
    const before = evaluateObservabilitySnapshot({
      traces,
      health: health.body,
      expectedInvocationIds,
      requireHandoff: true,
    });
    writeJson(path.join(dumpDir, "before-restart.json"), {
      traces,
      health: health.body,
      audit: before,
    });

    await harness.close();
    harness = null;
    restarted = await startHarness(opts, { dumpDir });
    const restoredTraces = await restarted.api.listTraces(sessionId);
    const restoredHealth = await restarted.api.health();
    const after = evaluateObservabilitySnapshot({
      traces: restoredTraces,
      health: restoredHealth.body,
      expectedInvocationIds,
      requireHandoff: true,
    });
    const restart = compareRestartSnapshots(before, after);
    const hard = [...before.assertions, ...restart.assertions];
    const passed = before.passed && restart.passed;
    writeJson(path.join(dumpDir, "after-restart.json"), {
      traces: restoredTraces,
      health: restoredHealth.body,
      audit: after,
      restart,
    });
    writeReport(dumpDir, {
      title: "Live observability acceptance",
      scenarioId: "trace-observability-1d",
      mode: "spawn",
      sessionId,
      turnCount: 1,
      durationMs: Date.now() - startedAt,
      exitCode: passed ? 0 : 1,
      runKind: "clean",
      cleanRunPassed: passed,
      hard,
      soft: [],
      notes: [
        `traceIds=${before.traceIds.join(",")}`,
        `invocationIds=${before.invocationIds.join(",")}`,
        `handoffIds=${before.acceptedHandoffIds.join(",")}`,
        `dump=${dumpDir}`,
      ],
    });
    process.exitCode = passed ? 0 : 1;
  } catch (error) {
    writeReport(dumpDir, {
      title: "Live observability acceptance",
      scenarioId: "trace-observability-1d",
      mode: "spawn",
      sessionId,
      turnCount: sessionId ? 1 : 0,
      durationMs: Date.now() - startedAt,
      exitCode: 1,
      runKind: "clean",
      cleanRunPassed: false,
      hard: [],
      soft: [],
      error: error.stack || String(error),
    });
    console.error(`[observability-live] ${error.message}`);
    process.exitCode = 1;
  } finally {
    await harness?.close().catch(() => {});
    await restarted?.close().catch(() => {});
  }
  console.log(`[observability-live] report: ${path.join(dumpDir, "report.md")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

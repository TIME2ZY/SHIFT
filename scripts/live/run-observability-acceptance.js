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
  evaluatePhase3Release,
} = require("./lib/observability-audit");
const { startObservabilityReceiver } = require("./lib/observability-receiver");

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
  let receiver = null;
  let sessionId = "";
  const priorExportEndpoint = process.env.SHIFT_OBSERVABILITY_EXPORT_ENDPOINT;
  const priorExportProtocol = process.env.SHIFT_OBSERVABILITY_EXPORT_PROTOCOL;
  const startedAt = Date.now();
  try {
    receiver = await startObservabilityReceiver();
    process.env.SHIFT_OBSERVABILITY_EXPORT_ENDPOINT = receiver.endpoint;
    process.env.SHIFT_OBSERVABILITY_EXPORT_PROTOCOL = "shift-webhook";
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
    const metrics = await harness.api.observabilityMetrics();
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
    const phase3BeforeRestart = evaluatePhase3Release({
      metrics: metrics.body,
      health: health.body,
      exportRequests: receiver.requests,
    });
    restarted = await startHarness(opts, { dumpDir });
    const restoredTraces = await restarted.api.listTraces(sessionId);
    const restoredHealth = await restarted.api.health();
    const restoredMetrics = await restarted.api.observabilityMetrics();
    const after = evaluateObservabilitySnapshot({
      traces: restoredTraces,
      health: restoredHealth.body,
      expectedInvocationIds,
      requireHandoff: true,
    });
    const restart = compareRestartSnapshots(before, after);
    await restarted.close();
    restarted = null;
    const phase3AfterRestart = evaluatePhase3Release({
      metrics: restoredMetrics.body,
      health: restoredHealth.body,
      exportRequests: receiver.requests,
    });
    const hard = [
      ...before.assertions,
      ...restart.assertions,
      ...phase3BeforeRestart.assertions,
      ...phase3AfterRestart.assertions,
    ];
    const passed =
      before.passed && restart.passed && phase3BeforeRestart.passed && phase3AfterRestart.passed;
    writeJson(path.join(dumpDir, "after-restart.json"), {
      traces: restoredTraces,
      health: restoredHealth.body,
      audit: after,
      restart,
      phase3BeforeRestart,
      phase3AfterRestart,
      exportRequestCount: receiver.requests.length,
    });
    writeReport(dumpDir, {
      title: "Live observability acceptance",
      scenarioId: "trace-observability-phase-3",
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
      scenarioId: "trace-observability-phase-3",
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
    await receiver?.close().catch(() => {});
    restoreEnv("SHIFT_OBSERVABILITY_EXPORT_ENDPOINT", priorExportEndpoint);
    restoreEnv("SHIFT_OBSERVABILITY_EXPORT_PROTOCOL", priorExportProtocol);
  }
  console.log(`[observability-live] report: ${path.join(dumpDir, "report.md")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

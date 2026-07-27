#!/usr/bin/env node
/**
 * Live solo-Grok multi-turn conversation driver.
 *
 * - Real Grok CLI (server default spawn)
 * - Same runtime DB / sessions as normal SHIFT use (no isolated laboratory DB)
 * - NOT collected by npm test
 *
 *   SHIFT_TEST_CAPACITY=50000 npm start          # terminal 1 (for 50K seal window)
 *   npm run test:live:solo-grok                 # terminal 2 (attach, default)
 *
 *   npm run test:live:solo-grok -- --mode spawn # one process, same default runtime paths
 */

const path = require("node:path");

const { parseArgs, printHelp } = require("./lib/parse-args");
const { preflight, printPreflight, ROOT } = require("./lib/preflight");
const { createApiClient } = require("./lib/api-client");
const { startHarness, resolveProjectDir } = require("./lib/harness");
const { collectMemoryInjectPayloads } = require("./lib/sse");
const { evaluateLiveRun } = require("./lib/live-assert");
const {
  createDumpDir,
  dumpTurn,
  writeReport,
  writeJson,
} = require("./lib/live-dump");
const scenario = require("./scenarios/solo-grok-auth");

const EXIT = {
  OK: 0,
  HARD_FAIL: 1,
  PREFLIGHT: 2,
  TIMEOUT: 3,
  STRICT_SOFT: 4,
};

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    printHelp();
    process.exit(EXIT.PREFLIGHT);
  }

  if (opts.help) {
    printHelp();
    process.exit(EXIT.OK);
  }

  console.log(`\nSHIFT live · ${scenario.TITLE}`);
  console.log(`scenario=${scenario.SCENARIO_ID} agent=${scenario.AGENT} mode=${opts.mode}\n`);

  // Early attach client for preflight health (token may still be missing).
  let probeApi = null;
  if (opts.mode === "attach" && opts.uiToken) {
    probeApi = createApiClient({ baseUrl: opts.apiUrl, uiToken: opts.uiToken });
  }

  const pf = await preflight(opts, { api: probeApi });
  printPreflight(pf);

  if (opts.dryRun) {
    console.log("\n[dry-run] stack turns:");
    for (const t of scenario.STACK_TURNS) {
      console.log(`  - ${t.id}: ${t.prompt.slice(0, 80)}…`);
    }
    console.log(`  - ${scenario.RECALL_TURN.id}: ${scenario.RECALL_TURN.prompt.slice(0, 80)}…`);
    process.exit(pf.ok ? EXIT.OK : EXIT.PREFLIGHT);
  }

  if (!pf.ok) {
    console.error("\nPreflight failed.");
    process.exit(EXIT.PREFLIGHT);
  }

  const dumpDir = createDumpDir(opts.dumpDir);
  console.log(`\n[live] dump → ${dumpDir}\n`);

  const startedAt = Date.now();
  let harness;
  const turnRecords = [];
  let sessionId = opts.sessionId || "";
  let sealed = false;
  let sealTurnId = null;
  let fatalError = null;

  const totalTimer =
    opts.totalTimeoutMs > 0
      ? setTimeout(() => {
          fatalError = new Error(`total timeout after ${opts.totalTimeoutMs}ms`);
        }, opts.totalTimeoutMs)
      : null;

  try {
    harness = await startHarness(opts, { dumpDir });
    const { api, prompts } = harness;
    const projectDir = resolveProjectDir(opts);

    // Re-check health after spawn
    const health = await api.health();
    if (!health.ok) {
      throw new Error(
        `storage health failed (${health.status}): ${JSON.stringify(health.body)}`
      );
    }

    if (!sessionId) {
      const session = await api.createSession();
      sessionId = session.id;
      console.log(`[live] created session ${sessionId}`);
    } else {
      await api.getSession(sessionId);
      console.log(`[live] continuing session ${sessionId}`);
    }

    try {
      await api.setProjectDir(sessionId, projectDir);
      console.log(`[live] projectDir=${projectDir}`);
    } catch (error) {
      console.warn(`[live] setProjectDir skipped/failed: ${error.message}`);
    }

    writeJson(path.join(dumpDir, "meta.json"), {
      scenarioId: scenario.SCENARIO_ID,
      mode: opts.mode,
      capacity: opts.capacity,
      sessionId,
      projectDir,
      baseUrl: api.baseUrl,
      startedAt: new Date(startedAt).toISOString(),
    });

    const fillTurns = scenario.STACK_TURNS.slice(0, opts.maxFillTurns);
    let turnIndex = 0;

    for (const turn of fillTurns) {
      if (fatalError) throw fatalError;
      turnIndex += 1;
      console.log(`\n── turn ${turnIndex}/${fillTurns.length} · ${turn.id} ──`);
      console.log(`user: ${turn.prompt.slice(0, 120)}${turn.prompt.length > 120 ? "…" : ""}`);

      const result = await api.chat({
        sessionId,
        agent: scenario.AGENT,
        prompt: turn.prompt,
        timeoutMs: opts.turnTimeoutMs,
      });

      const memoryInjects = collectMemoryInjectPayloads(result.events);
      const record = {
        turnId: turn.id,
        ok: result.ok,
        status: result.status,
        durationMs: result.durationMs,
        assistantText: result.assistantText,
        summary: result.summary,
        memoryInjects,
      };
      turnRecords.push(record);
      dumpTurn(dumpDir, turnIndex, turn, result, { memoryInjects });

      console.log(
        `  http=${result.status} duration=${result.durationMs}ms ` +
          `assistantChars=${(result.assistantText || "").length} ` +
          `sealed=${result.summary.sealed.length} memory-inject=${result.summary.memoryInject}`
      );
      if (result.summary.errors?.length) {
        console.warn("  errors:", JSON.stringify(result.summary.errors).slice(0, 300));
      }
      if (!result.ok) {
        throw new Error(`chat failed on ${turn.id} status=${result.status}`);
      }

      if (result.summary.sealed?.length) {
        sealed = true;
        sealTurnId = turn.id;
        console.log(`  ★ sealed (agent=${result.summary.sealed[0]?.agent}) — stopping fill turns`);
        break;
      }
    }

    // Recall turn
    if (fatalError) throw fatalError;
    turnIndex += 1;
    const recall = scenario.RECALL_TURN;
    console.log(`\n── turn ${turnIndex} · ${recall.id} (recall) ──`);
    const recallResult = await api.chat({
      sessionId,
      agent: scenario.AGENT,
      prompt: recall.prompt,
      timeoutMs: opts.turnTimeoutMs,
    });
    const recallInjects = collectMemoryInjectPayloads(recallResult.events);
    turnRecords.push({
      turnId: recall.id,
      ok: recallResult.ok,
      status: recallResult.status,
      durationMs: recallResult.durationMs,
      assistantText: recallResult.assistantText,
      summary: recallResult.summary,
      memoryInjects: recallInjects,
    });
    dumpTurn(dumpDir, turnIndex, recall, recallResult, { memoryInjects: recallInjects });
    console.log(
      `  http=${recallResult.status} duration=${recallResult.durationMs}ms ` +
        `assistantChars=${(recallResult.assistantText || "").length}`
    );

    if (recallResult.summary.sealed?.length) {
      sealed = true;
      sealTurnId = sealTurnId || recall.id;
    }

    const memoriesPayload = await api.listMemories(sessionId, { includeRetired: true });
    writeJson(path.join(dumpDir, "snapshot-memories.json"), memoriesPayload);

    try {
      const usage = await api.getUsage(sessionId);
      writeJson(path.join(dumpDir, "snapshot-usage.json"), usage.body || usage);
    } catch {
      // optional
    }

    try {
      const messages = await api.getMessages(sessionId);
      writeJson(path.join(dumpDir, "snapshot-messages.json"), { messages });
    } catch {
      // optional
    }

    const evaluated = evaluateLiveRun({
      opts,
      sessionId,
      turns: turnRecords,
      sealed,
      sealTurnId,
      memoriesPayload,
      prompts: harness.prompts || [],
      preflightNotes: pf.notes,
    });

    const report = {
      scenarioId: scenario.SCENARIO_ID,
      mode: opts.mode,
      capacity: opts.capacity,
      sessionId,
      sealed,
      sealTurnId,
      turnCount: turnRecords.length,
      durationMs: Date.now() - startedAt,
      exitCode: evaluated.exitCode,
      productMemoryCount: evaluated.productMemoryCount,
      productMemories: evaluated.productMemories,
      hard: evaluated.hard,
      soft: evaluated.soft,
      notes: [
        ...evaluated.notes,
        `dump: ${dumpDir}`,
        `session kept in runtime DB — open UI to continue chatting`,
      ],
      hardFailed: evaluated.hardFailed,
      softFailed: evaluated.softFailed,
    };

    writeReport(dumpDir, report);
    printSummary(report, dumpDir);
    process.exitCode = report.exitCode;
  } catch (error) {
    fatalError = error;
    const isTimeout = /timeout/i.test(error.message || "");
    const report = {
      scenarioId: scenario.SCENARIO_ID,
      mode: opts.mode,
      capacity: opts.capacity,
      sessionId,
      sealed,
      sealTurnId,
      turnCount: turnRecords.length,
      durationMs: Date.now() - startedAt,
      exitCode: isTimeout ? EXIT.TIMEOUT : EXIT.HARD_FAIL,
      productMemoryCount: 0,
      hard: [],
      soft: [],
      notes: pf?.notes || [],
      error: error.stack || String(error),
    };
    try {
      writeReport(dumpDir, report);
    } catch {
      // ignore
    }
    console.error(`\n[live] failed: ${error.message}`);
    console.error(`[live] dump → ${dumpDir}`);
    process.exitCode = report.exitCode;
  } finally {
    if (totalTimer) clearTimeout(totalTimer);
    if (harness) {
      try {
        await harness.close();
      } catch {
        // ignore
      }
    }
  }
}

function printSummary(report, dumpDir) {
  console.log("\n════════ live summary ════════");
  console.log(`exitCode=${report.exitCode} sealed=${report.sealed} session=${report.sessionId}`);
  console.log(`productMemories=${report.productMemoryCount} turns=${report.turnCount}`);
  for (const a of report.hard || []) {
    console.log(`  hard ${a.ok ? "OK" : "FAIL"} ${a.id}: ${a.message}`);
  }
  for (const a of report.soft || []) {
    console.log(`  soft ${a.ok ? "OK" : "MISS"} ${a.id}: ${a.message}`);
  }
  if (dumpDir) console.log(`report: ${path.join(dumpDir, "report.md")}`);
  console.log("session kept in runtime — open the UI to continue this thread");
  console.log("══════════════════════════════\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(EXIT.HARD_FAIL);
});

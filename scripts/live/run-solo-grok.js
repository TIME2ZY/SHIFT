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
const { preflight, printPreflight } = require("./lib/preflight");
const { createApiClient } = require("./lib/api-client");
const { startHarness, resolveProjectDir } = require("./lib/harness");
const { collectMemoryInjectPayloads } = require("./lib/sse");
const {
  evaluateLiveRun,
  annotateTurnOutcomes,
  classifyTurnOutcome,
} = require("./lib/live-assert");
const {
  createDumpDir,
  dumpTurn,
  writeReport,
  writeJson,
  writeText,
} = require("./lib/live-dump");
const scenario = require("./scenarios/solo-grok-auth");
const { DEFAULT_MEMORY_DB_FILE } = require("../../src/shared/runtime-paths");

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
  const isResume = Boolean(opts.sessionId || opts.startFrom);
  const runKind = isResume ? "resume" : "clean";
  if (isResume && !opts.allowResume) {
    console.warn(
      "[live] WARNING: --session-id/--start-from marks a RESUME run; clean-run acceptance will FAIL unless --allow-resume"
    );
  }

  const totalTimer =
    opts.totalTimeoutMs > 0
      ? setTimeout(() => {
          fatalError = new Error(`total timeout after ${opts.totalTimeoutMs}ms`);
        }, opts.totalTimeoutMs)
      : null;

  try {
    harness = await startHarness(opts, { dumpDir });
    const { api } = harness;
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
      runKind,
      allowResume: Boolean(opts.allowResume),
      startedAt: new Date(startedAt).toISOString(),
    });

    let fillTurns = scenario.STACK_TURNS.slice(0, opts.maxFillTurns);
    if (opts.startFrom) {
      const idx = fillTurns.findIndex((t) => t.id === opts.startFrom);
      if (idx < 0) {
        throw new Error(
          `--start-from ${opts.startFrom} not found in stack turns: ${fillTurns.map((t) => t.id).join(", ")}`
        );
      }
      fillTurns = fillTurns.slice(idx);
      console.log(`[live] resuming stack from ${opts.startFrom} (${fillTurns.length} fill turns left)`);
    }
    let turnIndex = 0;

    for (const turn of fillTurns) {
      if (fatalError) throw fatalError;
      turnIndex += 1;
      console.log(`\n── turn ${turnIndex}/${fillTurns.length} · ${turn.id} ──`);
      console.log(`user: ${turn.prompt.slice(0, 120)}${turn.prompt.length > 120 ? "…" : ""}`);

      const result = await chatWithRetry(api, {
        sessionId,
        agent: scenario.AGENT,
        prompt: turn.prompt,
        timeoutMs: opts.turnTimeoutMs,
        retries: opts.chatRetries,
        label: turn.id,
      });

      const memoryInjects = collectMemoryInjectPayloads(result.events);
      const record = buildTurnRecord(turn, result, memoryInjects);
      turnRecords.push(record);
      dumpTurn(dumpDir, turnIndex, turn, result, {
        memoryInjects,
        outcome: record.outcome,
        failure: record.failure,
      });

      console.log(
        `  http=${result.status} duration=${result.durationMs}ms ` +
          `assistantChars=${(result.assistantText || "").length} ` +
          `outcome=${record.outcome} ` +
          `sealed=${result.summary.sealed.length} memory-inject=${result.summary.memoryInject}`
      );
      if (result.summary.errors?.length) {
        console.warn("  errors:", JSON.stringify(result.summary.errors).slice(0, 300));
      }
      if (!result.ok) {
        dumpFailure(dumpDir, turn.id, result, {
          phase: "chat",
          sessionId,
          sealed,
        });
        throw new Error(
          `chat failed on ${turn.id} status=${result.status}: ${summarizeFailure(result)}`
        );
      }

      if (result.summary.sealed?.length) {
        sealed = true;
        sealTurnId = turn.id;
        if (record.outcome === "seal-empty") {
          console.warn(
            "  ⚠ seal-empty: user prompt not answered (will hard-fail L9/L10 unless product replays)"
          );
        }
        console.log(`  ★ sealed (agent=${result.summary.sealed[0]?.agent}) — stopping fill turns`);
        break;
      }
    }

    // Recall turn
    if (fatalError) throw fatalError;
    turnIndex += 1;
    const recall = scenario.RECALL_TURN;
    console.log(`\n── turn ${turnIndex} · ${recall.id} (recall) ──`);
    const recallResult = await chatWithRetry(api, {
      sessionId,
      agent: scenario.AGENT,
      prompt: recall.prompt,
      timeoutMs: opts.turnTimeoutMs,
      retries: opts.chatRetries,
      label: recall.id,
    });
    const recallInjects = collectMemoryInjectPayloads(recallResult.events);
    const recallRecord = buildTurnRecord(recall, recallResult, recallInjects);
    turnRecords.push(recallRecord);
    dumpTurn(dumpDir, turnIndex, recall, recallResult, {
      memoryInjects: recallInjects,
      outcome: recallRecord.outcome,
    });
    console.log(
      `  http=${recallResult.status} duration=${recallResult.durationMs}ms ` +
        `assistantChars=${(recallResult.assistantText || "").length} outcome=${recallRecord.outcome}`
    );

    if (!recallResult.ok) {
      dumpFailure(dumpDir, recall.id, recallResult, {
        phase: "recall",
        sessionId,
        sealed,
      });
      throw new Error(
        `chat failed on ${recall.id} status=${recallResult.status}: ${summarizeFailure(recallResult)}`
      );
    }

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

    let messages = [];
    try {
      messages = await api.getMessages(sessionId);
      writeJson(path.join(dumpDir, "snapshot-messages.json"), { messages });
      attachUserMessageIds(turnRecords, messages);
    } catch {
      // optional
    }

    const windows = snapshotWindows(sessionId);
    writeJson(path.join(dumpDir, "snapshot-windows.json"), { windows });

    const annotated = annotateTurnOutcomes(turnRecords);
    writeJson(path.join(dumpDir, "turns-annotated.json"), annotated);

    const evaluated = evaluateLiveRun({
      opts,
      sessionId,
      turns: annotated,
      sealed,
      sealTurnId,
      memoriesPayload,
      prompts: harness.prompts || [],
      preflightNotes: pf.notes,
      runKind,
      windows,
      stackTurnIds: scenario.STACK_TURNS.slice(0, opts.maxFillTurns).map((t) => t.id),
    });

    const report = {
      scenarioId: scenario.SCENARIO_ID,
      mode: opts.mode,
      capacity: opts.capacity,
      sessionId,
      sealed,
      sealTurnId,
      turnCount: annotated.length,
      durationMs: Date.now() - startedAt,
      exitCode: evaluated.exitCode,
      runKind: evaluated.runKind,
      cleanRunPassed: evaluated.cleanRunPassed,
      resumeRunPassed: evaluated.resumeRunPassed,
      productMemoryCount: evaluated.productMemoryCount,
      productMemories: evaluated.productMemories,
      hard: evaluated.hard,
      soft: evaluated.soft,
      notes: [
        ...evaluated.notes,
        `dump: ${dumpDir}`,
        `session kept in runtime DB — open UI to continue chatting`,
        `cleanRunPassed=${evaluated.cleanRunPassed} resumeRunPassed=${evaluated.resumeRunPassed}`,
      ],
      hardFailed: evaluated.hardFailed,
      softFailed: evaluated.softFailed,
      injectItemCount: evaluated.injectItemCount,
      relatedCount: evaluated.relatedCount,
      recencyCount: evaluated.recencyCount,
    };

    writeReport(dumpDir, report);
    printSummary(report, dumpDir);
    process.exitCode = report.exitCode;
  } catch (error) {
    fatalError = error;
    const isTimeout = /timeout/i.test(error.message || "");
    const windows = sessionId ? snapshotWindows(sessionId) : [];
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
      runKind,
      cleanRunPassed: false,
      resumeRunPassed: false,
      productMemoryCount: 0,
      hard: [],
      soft: [],
      notes: pf?.notes || [],
      error: error.stack || String(error),
      windows,
    };
    try {
      writeJson(path.join(dumpDir, "failure-context.json"), {
        phase: "runner",
        sessionId,
        sealed,
        sealTurnId,
        turnCount: turnRecords.length,
        lastTurns: turnRecords.slice(-3),
        windows,
        error: { message: error.message, stack: error.stack, name: error.name },
      });
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

function isRetryableChatFailure(result) {
  if (!result) return true;
  if (result.ok) return false;
  if (result.status >= 500) return true;
  const blob = `${result.text || ""}${JSON.stringify(result.summary?.errors || [])}`;
  return /database is locked|SQLITE_BUSY|SQLITE_BUSY_SNAPSHOT/i.test(blob);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function chatWithRetry(api, { sessionId, agent, prompt, timeoutMs, retries = 3, label }) {
  let last = null;
  const attempts = Math.max(1, Number(retries) || 1);
  for (let i = 1; i <= attempts; i += 1) {
    last = await api.chat({ sessionId, agent, prompt, timeoutMs });
    if (last.ok) return last;
    if (!isRetryableChatFailure(last) || i === attempts) return last;
    const waitMs = 1500 * i;
    console.warn(
      `  [retry ${i}/${attempts}] ${label} http=${last.status} — waiting ${waitMs}ms (sqlite busy / 5xx)`
    );
    await sleep(waitMs);
  }
  return last;
}

function buildTurnRecord(turn, result, memoryInjects) {
  const base = {
    turnId: turn.id,
    userPrompt: turn.prompt,
    ok: result.ok,
    status: result.status,
    durationMs: result.durationMs,
    assistantText: result.assistantText,
    summary: result.summary,
    memoryInjects,
    failure: result.ok
      ? null
      : {
          status: result.status,
          bodyPreview: String(result.text || "").slice(0, 2000),
          errors: result.summary?.errors || [],
        },
  };
  base.outcome = classifyTurnOutcome(base);
  return base;
}

function attachUserMessageIds(turnRecords, messages) {
  const users = (messages || []).filter((m) => m.role === "user");
  // Best-effort: match by order of user prompts in this run
  let ui = 0;
  for (const t of turnRecords) {
    while (ui < users.length) {
      const msg = users[ui];
      ui += 1;
      if (String(msg.content || "").includes(String(t.userPrompt || "").slice(0, 40))) {
        t.userMessageId = msg.id;
        break;
      }
    }
  }
}

function snapshotWindows(sessionId) {
  if (!sessionId) return [];
  try {
    const { createStorage } = require("../../src/storage");
    const file = process.env.SHIFT_MEMORY_DB || DEFAULT_MEMORY_DB_FILE;
    const storage = createStorage({ file });
    try {
      return storage.windows.listForThread(sessionId).map((w) => ({
        id: w.id,
        generation: w.generation,
        state: w.state,
        capacityTokens: w.capacityTokens,
        inputChars: w.inputChars,
        outputChars: w.outputChars,
        contextUsedTokens: w.contextUsedTokens,
        sealReason: w.sealReason || null,
        providerSessionId: w.providerSessionId || null,
      }));
    } finally {
      storage.close();
    }
  } catch (error) {
    console.warn(`[live] window snapshot failed: ${error.message}`);
    return [];
  }
}

function dumpFailure(dumpDir, turnId, result, ctx) {
  try {
    writeJson(path.join(dumpDir, `failure-${turnId}.json`), {
      turnId,
      ...ctx,
      status: result.status,
      // SSE/error body may contain the only server message we get
      bodyPreview: String(result.text || "").slice(0, 8000),
      summary: result.summary,
      sanitizedHint:
        "Server may only return {error:'Internal server error.'}; check server logs for SqliteError/stack.",
    });
    writeText(
      path.join(dumpDir, `failure-${turnId}.sse.txt`),
      String(result.text || "")
    );
  } catch {
    // ignore
  }
}

function summarizeFailure(result) {
  const text = String(result.text || "");
  try {
    const j = JSON.parse(text);
    if (j?.error) return j.error;
  } catch {
    // not json
  }
  const err = result.summary?.errors?.[0];
  if (err) return typeof err === "string" ? err : JSON.stringify(err);
  return text.slice(0, 200) || `HTTP ${result.status}`;
}

function printSummary(report, dumpDir) {
  console.log("\n════════ live summary ════════");
  console.log(
    `exitCode=${report.exitCode} runKind=${report.runKind} ` +
      `cleanRunPassed=${report.cleanRunPassed} resumeRunPassed=${report.resumeRunPassed}`
  );
  console.log(`sealed=${report.sealed} session=${report.sessionId}`);
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

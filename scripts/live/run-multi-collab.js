#!/usr/bin/env node
/**
 * Live serial multi-agent collab:
 *   discuss (Gemini↔Codex) @ 22K, no worktree
 *   implement (Grok↔OpenCode) @ 48K, useWorktree=true
 *   recall @ 48K
 *
 * NOT part of npm test. Same runtime DB as normal SHIFT use.
 *
 *   npm run test:live:multi-collab -- --mode spawn
 *   npm run test:live:multi-collab -- --mode spawn --dry-run
 */

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { ENV } = require("../../src/shared/brand");
const { DEFAULT_MEMORY_DB_FILE } = require("../../src/shared/runtime-paths");
const { parseArgs } = require("./lib/parse-args");
const { startHarness, resolveProjectDir } = require("./lib/harness");
const { createDumpDir, dumpTurn, writeReport, writeJson } = require("./lib/live-dump");
const { buildTurnTrace, aggregateTrace } = require("./lib/multi-trace");
const { evaluateMultiCollab } = require("./lib/multi-assert");
const scenario = require("./scenarios/multi-auth-collab");

const EXIT = { OK: 0, HARD_FAIL: 1, PREFLIGHT: 2, TIMEOUT: 3, STRICT_SOFT: 4 };

function printHelp() {
  console.log(`
Usage: node scripts/live/run-multi-collab.js [options]

Serial multi-agent live collab (Gemini↔Codex discuss @22K, Grok↔OpenCode implement @48K + worktree).
NOT part of npm test.

Options (same family as solo live):
  --mode attach|spawn     default attach; spawn recommended for capacity switch
  --capacity <n>          ignored for phase defaults unless --force-single-capacity
  --force-single-capacity use one capacity for all phases (value from --capacity)
  --discuss-capacity <n>  default 22000
  --implement-capacity <n> default 48000
  --api-url / --ui-token / --project-dir / --session-id
  --turn-timeout-ms / --chat-retries
  --allow-resume / --strict-memory / --dry-run / --dump-dir
  -h, --help
`);
}

function parseMultiArgs(argv) {
  const base = parseArgs(
    argv.filter(
      (a) =>
        !a.startsWith("--discuss-capacity") &&
        !a.startsWith("--implement-capacity") &&
        a !== "--force-single-capacity"
    )
  );
  let discussCapacity = 22_000;
  let implementCapacity = 48_000;
  let forceSingle = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--force-single-capacity") forceSingle = true;
    if (arg === "--discuss-capacity") discussCapacity = Number(argv[++i]) || discussCapacity;
    if (arg?.startsWith("--discuss-capacity=")) {
      discussCapacity = Number(arg.split("=")[1]) || discussCapacity;
    }
    if (arg === "--implement-capacity") implementCapacity = Number(argv[++i]) || implementCapacity;
    if (arg?.startsWith("--implement-capacity=")) {
      implementCapacity = Number(arg.split("=")[1]) || implementCapacity;
    }
  }
  if (forceSingle && base.capacity) {
    discussCapacity = base.capacity;
    implementCapacity = base.capacity;
  }
  return { ...base, discussCapacity, implementCapacity, forceSingleCapacity: forceSingle };
}

function setLiveCapacity(tokens) {
  process.env[ENV.TEST_CAPACITY] = String(tokens);
  console.log(`[live] SHIFT_TEST_CAPACITY=${tokens}`);
}

function checkCli(name) {
  const which = process.platform === "win32" ? "where" : "which";
  // gemini uses antigravity CLI in catalog; still check common binaries
  // Gemini provider uses Antigravity CLI; binary is often `agy` on PATH.
  const candidates =
    name === "gemini"
      ? ["agy", "antigravity", "gemini"]
      : name === "codex"
        ? ["codex"]
        : name === "grok"
          ? ["grok"]
          : name === "opencode"
            ? ["opencode"]
            : [name];
  for (const bin of candidates) {
    const r = spawnSync(which, [bin], { encoding: "utf8", shell: true });
    if (r.status === 0 && String(r.stdout || "").trim()) {
      return { ok: true, bin: String(r.stdout).split(/\r?\n/).find(Boolean) || bin };
    }
  }
  return { ok: false, bin: null };
}

function preflightMulti(opts) {
  const notes = [];
  const errors = [];
  notes.push(`mode=${opts.mode}`);
  notes.push(
    `discuss capacity=${opts.discussCapacity} implement capacity=${opts.implementCapacity}`
  );
  notes.push(`scenario=${scenario.SCENARIO_ID}`);
  for (const name of scenario.REQUIRED_CLIS || []) {
    const c = checkCli(name);
    if (c.ok) notes.push(`cli ${name}: ${c.bin}`);
    else errors.push(`CLI not found for agent "${name}" (checked PATH)`);
  }
  if (opts.mode === "attach" && !opts.uiToken) {
    errors.push("attach mode requires --ui-token or SHIFT_UI_TOKEN");
  }
  const db = DEFAULT_MEMORY_DB_FILE;
  notes.push(`runtime DB default: ${db}`);
  return { ok: errors.length === 0, notes, errors };
}

async function chatWithRetry(api, args) {
  const retries = Math.max(1, Number(args.retries) || 3);
  let last = null;
  for (let i = 1; i <= retries; i += 1) {
    last = await api.chat(args);
    if (last.ok) return last;
    if (last.status < 500 || i === retries) return last;
    const wait = 1500 * i;
    console.warn(
      `  [retry ${i}/${retries}] ${args.label || ""} http=${last.status} wait ${wait}ms`
    );
    await new Promise((r) => setTimeout(r, wait));
  }
  return last;
}

function snapshotWindows(sessionId) {
  try {
    const { createStorage } = require("../../src/storage");
    const file = DEFAULT_MEMORY_DB_FILE;
    const storage = createStorage({ file });
    try {
      return storage.windows.listForThread(sessionId).map((w) => ({
        id: w.id,
        agentId: w.agentId,
        generation: w.generation,
        state: w.state,
        capacityTokens: w.capacityTokens,
        sealReason: w.sealReason || null,
      }));
    } finally {
      storage.close();
    }
  } catch (error) {
    console.warn(`[live] window snapshot failed: ${error.message}`);
    return [];
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    printHelp();
    process.exit(EXIT.OK);
  }

  let opts;
  try {
    opts = parseMultiArgs(argv);
  } catch (error) {
    console.error(error.message);
    printHelp();
    process.exit(EXIT.PREFLIGHT);
  }

  console.log(`\nSHIFT live · ${scenario.TITLE}`);
  console.log(`scenario=${scenario.SCENARIO_ID} mode=${opts.mode}\n`);

  const pf = preflightMulti(opts);
  for (const n of pf.notes) console.log(`  · ${n}`);
  for (const e of pf.errors) console.error(`  ✗ ${e}`);

  if (opts.dryRun) {
    for (const phase of scenario.PHASES) {
      const cap = phase.id === "discuss" ? opts.discussCapacity : opts.implementCapacity;
      console.log(
        `\n[phase ${phase.id}] capacity=${cap} worktree=${Boolean(phase.useWorktree)} turns=${phase.turns.length}`
      );
      for (const t of phase.turns) {
        console.log(`  - ${t.id} @${t.agent}: ${t.prompt.slice(0, 72)}…`);
      }
    }
    // Dry-run always succeeds so authors can inspect scripts without all CLIs installed.
    process.exit(EXIT.OK);
  }
  if (!pf.ok) process.exit(EXIT.PREFLIGHT);

  // Initial capacity for discuss phase (spawn harness sets env once; we override per phase).
  opts.capacity = opts.discussCapacity;
  setLiveCapacity(opts.discussCapacity);

  const dumpDir = createDumpDir(opts.dumpDir, "multi-collab");
  console.log(`\n[live] dump → ${dumpDir}\n`);

  const startedAt = Date.now();
  const turnRecords = [];
  let sessionId = opts.sessionId || "";
  let harness;
  const runKind = sessionId ? "resume" : "clean";
  if (runKind === "resume" && !opts.allowResume) {
    console.warn("[live] resume without --allow-resume → clean acceptance will fail");
  }

  try {
    harness = await startHarness(opts, { dumpDir });
    const { api } = harness;
    const projectDir = resolveProjectDir(opts);

    const health = await api.health();
    if (!health.ok) {
      throw new Error(`storage health failed: ${health.status}`);
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
      console.warn(`[live] setProjectDir: ${error.message}`);
    }

    writeJson(path.join(dumpDir, "meta.json"), {
      scenarioId: scenario.SCENARIO_ID,
      mode: opts.mode,
      discussCapacity: opts.discussCapacity,
      implementCapacity: opts.implementCapacity,
      sessionId,
      projectDir,
      runKind,
      startedAt: new Date(startedAt).toISOString(),
    });

    let globalIndex = 0;
    for (const phase of scenario.PHASES) {
      const capacity = phase.id === "discuss" ? opts.discussCapacity : opts.implementCapacity;
      // implement + recall use implement capacity; discuss uses discuss.
      const phaseCapacity =
        phase.capacity != null
          ? phase.id === "discuss"
            ? opts.discussCapacity
            : phase.id === "implement" || phase.id === "recall"
              ? opts.implementCapacity
              : phase.capacity
          : capacity;
      setLiveCapacity(phaseCapacity);

      console.log(
        `\n════ phase ${phase.id} · ${phase.label} · capacity=${phaseCapacity} worktree=${Boolean(
          phase.useWorktree
        )} ════`
      );

      for (const turn of phase.turns) {
        globalIndex += 1;
        console.log(`\n── ${phase.id}/${turn.id} · @${turn.agent} ──`);
        console.log(`user: ${turn.prompt.slice(0, 120)}${turn.prompt.length > 120 ? "…" : ""}`);

        const result = await chatWithRetry(api, {
          sessionId,
          agent: turn.agent,
          prompt: turn.prompt,
          useWorktree: Boolean(phase.useWorktree),
          timeoutMs: opts.turnTimeoutMs,
          retries: opts.chatRetries,
          label: `${phase.id}/${turn.id}`,
        });

        const trace = buildTurnTrace(result.events, {
          turnId: turn.id,
          phaseId: phase.id,
          userPrompt: turn.prompt,
          requestedAgent: turn.agent,
          useWorktree: Boolean(phase.useWorktree),
          capacity: phaseCapacity,
          ok: result.ok,
          status: result.status,
          durationMs: result.durationMs,
        });
        turnRecords.push(trace);
        dumpTurn(dumpDir, globalIndex, turn, result, {
          phaseId: phase.id,
          agents: trace.agents,
          sealed: trace.sealed,
          a2aHops: trace.a2aHops,
          useWorktree: phase.useWorktree,
        });

        console.log(
          `  http=${result.status} duration=${result.durationMs}ms ` +
            `agents=[${trace.agents.join(",")}] a2aHops=${trace.a2aHops} ` +
            `sealed=${trace.sealed.length} assistantChars=${(trace.assistantText || "").length}`
        );
        if (trace.sealed.length) {
          console.log(
            `  ★ sealed: ${trace.sealed.map((s) => `${s.agent}:${s.reason || "?"}`).join(", ")}`
          );
        }
        if (!result.ok) {
          writeJson(path.join(dumpDir, `failure-${turn.id}.json`), {
            turnId: turn.id,
            phaseId: phase.id,
            status: result.status,
            bodyPreview: String(result.text || "").slice(0, 8000),
          });
          throw new Error(`chat failed ${phase.id}/${turn.id} status=${result.status}`);
        }
      }
    }

    let memoriesPayload = null;
    try {
      memoriesPayload = await api.listMemories(sessionId, { includeRetired: true });
      writeJson(path.join(dumpDir, "snapshot-memories.json"), memoriesPayload);
    } catch (error) {
      console.warn(`[live] listMemories: ${error.message}`);
    }

    try {
      const messages = await api.getMessages(sessionId);
      writeJson(path.join(dumpDir, "snapshot-messages.json"), { messages });
    } catch {
      // optional
    }

    const windows = snapshotWindows(sessionId);
    writeJson(path.join(dumpDir, "snapshot-windows.json"), { windows });
    writeJson(path.join(dumpDir, "turns-trace.json"), turnRecords);

    const aggregate = aggregateTrace(turnRecords, {
      memoryExpectations: scenario.MEMORY_EXPECTATIONS,
    });
    writeJson(path.join(dumpDir, "aggregate.json"), aggregate);

    const evaluated = evaluateMultiCollab({
      opts,
      sessionId,
      turns: turnRecords,
      aggregate,
      memoryExpectations: scenario.MEMORY_EXPECTATIONS,
      runKind,
      windows,
      memoriesPayload,
    });

    const report = {
      scenarioId: scenario.SCENARIO_ID,
      mode: opts.mode,
      sessionId,
      turnCount: turnRecords.length,
      durationMs: Date.now() - startedAt,
      exitCode: evaluated.exitCode,
      runKind: evaluated.runKind,
      cleanRunPassed: evaluated.cleanRunPassed,
      resumeRunPassed: evaluated.resumeRunPassed,
      hard: evaluated.hard,
      soft: evaluated.soft,
      hardFailed: evaluated.hardFailed,
      softFailed: evaluated.softFailed,
      aggregate,
      notes: [
        ...pf.notes,
        `dump: ${dumpDir}`,
        `discussCapacity=${opts.discussCapacity} implementCapacity=${opts.implementCapacity}`,
        "session kept in runtime DB",
      ],
    };
    writeReport(dumpDir, report);
    printSummary(report, dumpDir);
    process.exitCode = report.exitCode;
  } catch (error) {
    const report = {
      scenarioId: scenario.SCENARIO_ID,
      mode: opts.mode,
      sessionId,
      turnCount: turnRecords.length,
      durationMs: Date.now() - startedAt,
      exitCode: /timeout/i.test(error.message || "") ? EXIT.TIMEOUT : EXIT.HARD_FAIL,
      runKind,
      cleanRunPassed: false,
      hard: [],
      soft: [],
      error: error.stack || String(error),
      notes: pf.notes,
    };
    try {
      writeReport(dumpDir, report);
      writeJson(path.join(dumpDir, "failure-context.json"), {
        error: { message: error.message, stack: error.stack },
        turns: turnRecords.slice(-3),
      });
    } catch {
      // ignore
    }
    console.error(`\n[live] failed: ${error.message}`);
    console.error(`[live] dump → ${dumpDir}`);
    process.exitCode = report.exitCode;
  } finally {
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
  console.log("\n════════ multi-collab summary ════════");
  console.log(
    `exitCode=${report.exitCode} cleanRunPassed=${report.cleanRunPassed} session=${report.sessionId}`
  );
  if (report.aggregate) {
    console.log(
      `agents=${(report.aggregate.agentsSeen || []).join(",")} a2aHops=${report.aggregate.a2aHops} seals=${report.aggregate.sealEvents}`
    );
    const memory = report.aggregate.memoryRetrievalAudit;
    if (memory) {
      console.log(
        `memory retrieval availability=${formatPercent(memory.availabilityRate)} ` +
          `nonEmpty=${formatPercent(memory.nonEmptyHitRate)} ` +
          `related=${formatPercent(memory.relatedHitRate)} ` +
          `recall=${formatPercent(memory.recallSuccessRate)}`
      );
      const semantics = report.aggregate.memorySemanticAudit;
      if (semantics?.configured) {
        console.log(
          `memory semantics retrieved=${formatPercent(semantics.retrievalCoverage)} ` +
            `answer=${formatPercent(semantics.answerCoverage)} ` +
            `grounded=${formatPercent(semantics.groundedCoverage)} ` +
            `itemPrecision=${formatPercent(semantics.itemPrecision)}`
        );
      }
    }
  }
  for (const a of report.hard || []) {
    console.log(`  hard ${a.ok ? "OK" : "FAIL"} ${a.id}: ${a.message}`);
  }
  for (const a of report.soft || []) {
    console.log(`  soft ${a.ok ? "OK" : "MISS"} ${a.id}: ${a.message}`);
  }
  if (dumpDir) console.log(`report: ${path.join(dumpDir, "report.md")}`);
  console.log("══════════════════════════════════════\n");
}

function formatPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

main().catch((error) => {
  console.error(error);
  process.exit(EXIT.HARD_FAIL);
});

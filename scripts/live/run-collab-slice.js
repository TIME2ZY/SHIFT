#!/usr/bin/env node
/**
 * Live collab slice: Codex must hand off to Grok for an implementation_plan
 * on a real sandbox repo, without writing files.
 *
 * NOT part of npm test. Requires real Codex and Grok CLIs.
 *
 *   npm run test:live:collab-slice -- --instance dayjs-2505
 *   npm run test:live:collab-slice -- --dry-run
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { listInstances, loadInstance } = require("./lib/instances");
const { startLiveServer } = require("./lib/server");
const { createApiClient } = require("./lib/api");
const { createSandbox, gitChangedFiles } = require("./lib/sandbox");
const {
  buildCollabSlicePrompt,
  evaluateCollaboration,
  evaluateAcceptedHandoff,
  evaluateTerminalInvocations,
  evaluateCleanWorkspace,
  evaluateSnapshotStable,
} = require("./lib/collab-assert");
const { createDumpDir, writeJson, writeText, renderReportMd } = require("./lib/report");
const { EXIT, exitCodeForVerdict } = require("./lib/exit-codes");

const DEFAULT_TURN_TIMEOUT_MS = 20 * 60 * 1000;

function parseArgs(argv) {
  const opts = {
    instance: "dayjs-2505",
    source: "",
    dumpDir: "",
    timeoutMs: DEFAULT_TURN_TIMEOUT_MS,
    dryRun: false,
    useDefaultHome: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--instance") opts.instance = String(next() || "");
    else if (arg?.startsWith("--instance=")) opts.instance = arg.slice("--instance=".length);
    else if (arg === "--source") opts.source = String(next() || "");
    else if (arg?.startsWith("--source=")) opts.source = arg.slice("--source=".length);
    else if (arg === "--dump-dir") opts.dumpDir = String(next() || "");
    else if (arg?.startsWith("--dump-dir=")) opts.dumpDir = arg.slice("--dump-dir=".length);
    else if (arg === "--timeout-ms") opts.timeoutMs = Number(next()) || DEFAULT_TURN_TIMEOUT_MS;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--use-default-home") opts.useDefaultHome = true;
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
Usage: npm run test:live:collab-slice -- [options]

Options:
  --instance <id>         sandbox instance (default: dayjs-2505)
  --source <path|url>     repository source (default: instance repo URL)
  --dump-dir <dir>        artifact directory (default: output/live/collab-slice-<timestamp>)
  --timeout-ms <n>        chat turn timeout (default: ${DEFAULT_TURN_TIMEOUT_MS})
  --dry-run               print the plan and prompt without running anything
  --use-default-home      use the interactive SHIFT_HOME SQLite
  -h, --help              show this help
`);
}

function preflight() {
  const problems = [];
  const where = process.platform === "win32" ? "where" : "which";
  for (const cli of ["codex", "grok"]) {
    const lookup = spawnSync(where, [cli], { encoding: "utf8" });
    if (lookup.status !== 0) problems.push(`agent CLI "${cli}" not found on PATH`);
  }
  const gitVersion = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (gitVersion.status !== 0) problems.push("git is required but not available");
  return problems;
}

async function collectExecution(api, sessionId) {
  const traces = await api.listTraces(sessionId);
  const invocations = [];
  const handoffs = [];
  const details = [];
  for (const row of traces) {
    const detail = await api.getTrace(sessionId, row.traceId);
    if (!detail) continue;
    details.push(detail);
    invocations.push(...(detail.invocations || []));
    handoffs.push(...(detail.handoffs || []));
  }
  return { traces, details, invocations, handoffs };
}

async function runInstance({ instance, opts, harness }) {
  const log = (message) => console.log(`[${instance.id}] ${message}`);
  const dumpDir = path.join(harness.dumpDir, instance.id);
  fs.mkdirSync(dumpDir, { recursive: true });
  const prompt = buildCollabSlicePrompt(instance.issueText);
  const source = opts.source || instance.repo;

  if (opts.dryRun) {
    console.log(`\n[${instance.id}] dry run`);
    console.log(`  repo:        ${instance.repo} @ ${instance.baseCommit}`);
    console.log(`  agents:      codex → grok (plan only)`);
    console.log(`  source:      ${source}`);
    console.log(`  prompt (${prompt.length} chars):`);
    console.log(
      prompt
        .split("\n")
        .map((line) => `    | ${line}`)
        .join("\n")
    );
    return { verdict: "dry-run", checks: [] };
  }

  const sandboxDir = path.join(dumpDir, "target");
  const checks = [];
  const record = (name, evaluation) => {
    checks.push({ name, ok: evaluation.ok, problems: evaluation.problems || [] });
    log(
      `${evaluation.ok ? "PASS" : "FAIL"} ${name}${
        evaluation.problems?.length ? ` — ${evaluation.problems.join("; ")}` : ""
      }`
    );
    return evaluation;
  };

  createSandbox({
    instance,
    source,
    targetDir: sandboxDir,
    logger: log,
    applyTestPatch: false,
    install: false,
  });

  const project = await harness.api.openProject(sandboxDir);
  const session = await harness.api.createSession(project.projectKey);
  writeText(path.join(dumpDir, "session-id.txt"), session.id);
  log(`session ${session.id} bound to project ${project.projectKey}`);

  const clientTurnId = `live-collab-${instance.id}-${Date.now()}`;
  let events = [];
  let timedOut = false;
  try {
    events = await harness.api.chat({
      sessionId: session.id,
      agent: "codex",
      prompt,
      clientTurnId,
      timeoutMs: opts.timeoutMs,
      useWorktree: true,
      onEvent: (event) => {
        if (event.name === "agent-start") log(`invocation ${event.data?.invocationId} started`);
        if (event.name === "agent-exit") log(`agent exited with code ${event.data?.code}`);
        if (event.name === "a2a-skipped") log(`handoff skipped: ${event.data?.reason}`);
        if (event.name === "implementation-plan-submitted") {
          log(`implementation plan ${event.data?.accepted ? "accepted" : event.data?.reason}`);
        }
      },
    });
  } catch (error) {
    if (String(error?.message || error).includes("timeout") || error?.name === "AbortError") {
      timedOut = true;
    } else {
      throw error;
    }
  }
  writeText(
    path.join(dumpDir, "chat-sse.txt"),
    events.map((event) => `event: ${event.name}\ndata: ${JSON.stringify(event.data)}\n`).join("\n")
  );
  if (timedOut) {
    record("L-timeout", { ok: false, problems: [`chat turn exceeded ${opts.timeoutMs}ms`] });
    return finishRun({
      instance,
      verdict: "timeout",
      checks,
      dumpDir,
      sandboxDir,
      sessionId: session.id,
    });
  }

  const execution = await collectExecution(harness.api, session.id);
  writeJson(path.join(dumpDir, "execution.json"), execution);
  record("L-terminal-invocations", evaluateTerminalInvocations(execution.invocations));
  record("L-accepted-handoff", evaluateAcceptedHandoff(execution.handoffs));

  const collaboration = await harness.api.getCollaboration(session.id);
  writeJson(path.join(dumpDir, "collaboration.json"), collaboration);
  record("L-collaboration-plan", evaluateCollaboration(collaboration));

  const refreshed = await harness.api.getCollaboration(session.id);
  record("L-collaboration-stable", evaluateSnapshotStable(collaboration, refreshed));

  const projectFiles = gitChangedFiles(sandboxDir);
  const worktree = await harness.api.getWorktreeDiff(session.id);
  writeJson(path.join(dumpDir, "changed-files.json"), { projectFiles, worktree });
  record(
    "L-clean-workspace",
    evaluateCleanWorkspace({ projectFiles, worktreeDiff: worktree?.diff || "" })
  );

  const allOk = checks.every((check) => check.ok);
  return finishRun({
    instance,
    verdict: allOk ? "passed" : "failed",
    checks,
    dumpDir,
    sandboxDir,
    sessionId: session.id,
  });
}

function finishRun({ instance, verdict, checks, dumpDir, sandboxDir, sessionId }) {
  const result = {
    instanceId: instance.id,
    repo: instance.repo,
    baseCommit: instance.baseCommit,
    agent: "codex",
    verdict,
    sandboxDir,
    sessionId: sessionId || "",
    invocationId: "",
    chat: null,
    checks,
    artifacts: fs.existsSync(dumpDir) ? fs.readdirSync(dumpDir) : [],
  };
  writeJson(path.join(dumpDir, "report.json"), result);
  writeText(path.join(dumpDir, "report.md"), renderReportMd(result));
  console.log(
    `[${instance.id}] verdict: ${verdict} — report at ${path.join(dumpDir, "report.md")}`
  );
  return result;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  const available = listInstances();
  if (!available.includes(opts.instance)) {
    console.error(`unknown instance "${opts.instance}". available: ${available.join(", ")}`);
    process.exitCode = EXIT.PREFLIGHT;
    return;
  }

  const preflightProblems = preflight();
  if (preflightProblems.length > 0) {
    for (const problem of preflightProblems) console.error(`preflight: ${problem}`);
    process.exitCode = EXIT.PREFLIGHT;
    return;
  }

  const dumpDir = createDumpDir(opts.dumpDir, "collab-slice");
  const harness = { dumpDir, api: null };
  const instance = loadInstance(opts.instance);

  if (!opts.dryRun) {
    const server = await startLiveServer({
      logger: (message) => console.log(`[server] ${message}`),
      shiftHome: path.join(dumpDir, "shift-home"),
      useDefaultHome: opts.useDefaultHome,
    });
    harness.api = createApiClient({ baseUrl: server.baseUrl, token: server.token });
    try {
      const result = await runInstance({ instance, opts, harness });
      if (result.verdict !== "dry-run") {
        process.exitCode = exitCodeForVerdict(result.verdict);
      }
    } finally {
      await server.close();
    }
  } else {
    await runInstance({ instance, opts, harness });
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = EXIT.HARD_FAIL;
});

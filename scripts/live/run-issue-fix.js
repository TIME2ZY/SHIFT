#!/usr/bin/env node
/**
 * Live issue-fix scenario (S1): a real Agent CLI must resolve a real
 * upstream GitHub issue in an isolated sandbox repository, against the
 * same SHIFT runtime pipeline the UI uses.
 *
 * NOT part of npm test. Requires real provider credentials.
 *
 *   npm run test:live:issue-fix -- --instance dayjs-2505
 *   npm run test:live:issue-fix -- --instance all --agent grok
 *   npm run test:live:issue-fix -- --instance dayjs-2505 --dry-run
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { listInstances, loadInstance } = require("./lib/instances");
const { startLiveServer } = require("./lib/server");
const { createApiClient, summarizeChatEvents } = require("./lib/api");
const { createSandbox, runProjectTests, gitChangedFiles, captureDiff } = require("./lib/sandbox");
const {
  evaluatePreflightRed,
  evaluateResolution,
  evaluateChangedFiles,
  evaluateChatOutcome,
  evaluatePersistence,
  evaluateTrace,
  buildIssuePrompt,
} = require("./lib/assertions");
const { createDumpDir, writeJson, writeText, renderReportMd } = require("./lib/report");
const { EXIT, exitCodeForVerdict } = require("./lib/exit-codes");

const DEFAULT_TURN_TIMEOUT_MS = 20 * 60 * 1000;

function parseArgs(argv) {
  const opts = {
    instance: "all",
    agent: "codex",
    source: "",
    nodeModules: "",
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
    else if (arg === "--agent") opts.agent = String(next() || "");
    else if (arg?.startsWith("--agent=")) opts.agent = arg.slice("--agent=".length);
    else if (arg === "--source") opts.source = String(next() || "");
    else if (arg?.startsWith("--source=")) opts.source = arg.slice("--source=".length);
    else if (arg === "--node-modules") opts.nodeModules = String(next() || "");
    else if (arg?.startsWith("--node-modules="))
      opts.nodeModules = arg.slice("--node-modules=".length);
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
Usage: npm run test:live:issue-fix -- [options]

Options:
  --instance <id|all>     which instance to run (default: all; see scripts/live/instances/)
  --agent <id>            agent CLI to drive the fix (default: codex)
  --source <path|url>     repository source for the sandbox (default: instance repo URL)
  --node-modules <path>   junction an existing node_modules instead of npm ci (offline cache)
  --dump-dir <dir>        artifact directory (default: output/live/issue-fix-<timestamp>)
  --timeout-ms <n>        chat turn timeout (default: ${DEFAULT_TURN_TIMEOUT_MS})
  --dry-run               print the plan and prompt without running anything
  --use-default-home      use the interactive SHIFT_HOME SQLite (default: isolated under dump-dir)
  -h, --help              show this help
`);
}

function preflight(agent) {
  const problems = [];
  const where = process.platform === "win32" ? "where" : "which";
  const lookup = spawnSync(where, [agent], { encoding: "utf8" });
  if (lookup.status !== 0) {
    problems.push(`agent CLI "${agent}" not found on PATH`);
  }
  const gitVersion = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (gitVersion.status !== 0) {
    problems.push("git is required but not available");
  }
  return problems;
}

async function runInstance({ instance, opts, harness }) {
  const log = (message) => console.log(`[${instance.id}] ${message}`);
  const dumpDir = path.join(harness.dumpDir, instance.id);
  fs.mkdirSync(dumpDir, { recursive: true });
  const prompt = buildIssuePrompt(instance.issueText);
  const source = opts.source || instance.repo;

  if (opts.dryRun) {
    console.log(`\n[${instance.id}] dry run`);
    console.log(`  repo:        ${instance.repo} @ ${instance.baseCommit}`);
    console.log(`  agent:       ${opts.agent}`);
    console.log(`  source:      ${source}`);
    console.log(`  failToPass:  ${instance.failToPass.join(", ")}`);
    console.log(`  testArgs:    npx jest ${instance.testArgs.join(" ")}`);
    console.log(`  prompt (${prompt.length} chars):`);
    console.log(
      prompt
        .split("\n")
        .map((l) => `    | ${l}`)
        .join("\n")
    );
    return { verdict: "dry-run", checks: [] };
  }

  const sandboxDir = path.join(dumpDir, "target");
  const checks = [];
  const record = (name, evaluation) => {
    checks.push({ name, ok: evaluation.ok, problems: evaluation.problems || [] });
    log(
      `${evaluation.ok ? "PASS" : "FAIL"} ${name}${evaluation.problems?.length ? ` — ${evaluation.problems.join("; ")}` : ""}`
    );
    return evaluation;
  };

  // 1. Prepare sandbox at base commit with the F2P test patch committed.
  createSandbox({
    instance,
    source,
    targetDir: sandboxDir,
    nodeModules: opts.nodeModules,
    logger: log,
  });

  // 2. Preflight red: exactly the F2P tests must fail at the base commit.
  const jestBeforeFile = path.join(dumpDir, "jest-before.json");
  const before = runProjectTests({
    instance,
    targetDir: sandboxDir,
    outputFile: jestBeforeFile,
    logger: log,
  });
  const redCheck = record(
    "L3-f2p-red-at-base",
    evaluatePreflightRed(before.parsed, instance.failToPass)
  );
  if (!redCheck.ok) {
    return finishRun({ instance, opts, verdict: "invalid-instance", checks, dumpDir, sandboxDir });
  }

  // 3. Open the sandbox as a SHIFT project and send the issue as the user turn.
  const project = await harness.api.openProject(sandboxDir);
  const session = await harness.api.createSession(project.projectKey);
  writeText(path.join(dumpDir, "session-id.txt"), session.id);
  log(`session ${session.id} bound to project ${project.projectKey}`);

  const clientTurnId = `live-${instance.id}-${Date.now()}`;
  let events = [];
  let timedOut = false;
  try {
    events = await harness.api.chat({
      sessionId: session.id,
      agent: opts.agent,
      prompt,
      clientTurnId,
      timeoutMs: opts.timeoutMs,
      onEvent: (event) => {
        if (event.name === "agent-start") log(`invocation ${event.data?.invocationId} started`);
        if (event.name === "agent-exit") log(`agent exited with code ${event.data?.code}`);
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
    events.map((e) => `event: ${e.name}\ndata: ${JSON.stringify(e.data)}\n`).join("\n")
  );
  if (timedOut) {
    record("L-timeout", { ok: false, problems: [`chat turn exceeded ${opts.timeoutMs}ms`] });
    return finishRun({
      instance,
      opts,
      verdict: "timeout",
      checks,
      dumpDir,
      sandboxDir,
      sessionId: session.id,
    });
  }

  // 4. Chat outcome: terminal invocation + non-empty assistant answer.
  const chatSummary = summarizeChatEvents(events);
  writeJson(path.join(dumpDir, "chat-summary.json"), chatSummary);
  const traces = await harness.api.listTraces(session.id);
  const trace = traces.find((t) => t.clientTurnId === clientTurnId) || traces[0] || null;
  let traceDetail = null;
  if (trace) {
    traceDetail = await harness.api.getTrace(session.id, trace.traceId);
  }
  const invocationState =
    chatSummary.invocationId && traceDetail
      ? (traceDetail.invocations || []).find((i) => i.invocationId === chatSummary.invocationId)
          ?.state || ""
      : traceDetail?.state || "";
  record(
    "L6-chat-outcome",
    evaluateChatOutcome({
      exitCode: chatSummary.exitCode,
      assistantText: chatSummary.assistantText,
      invocationState,
      sseError: chatSummary.sseError,
    })
  );
  record("L7-durable-trace", evaluateTrace(traceDetail));

  // 5. Persistence: user + assistant-final messages must be durable.
  const messages = await harness.api.getMessages(session.id);
  writeJson(path.join(dumpDir, "messages.json"), messages);
  record(
    "L7-messages-persisted",
    evaluatePersistence(messages, {
      expectedUserTextPrefix: instance.issueText.trim().split("\n")[0],
    })
  );

  // 6. The agent may only touch allowed source paths.
  const changedFiles = gitChangedFiles(sandboxDir);
  writeJson(path.join(dumpDir, "changed-files.json"), changedFiles);
  record("L8-diff-scope", evaluateChangedFiles(changedFiles, instance.sourceAllowPrefixes));
  captureDiff(sandboxDir, path.join(dumpDir, "agent.patch"));

  // 7. Final test run: F2P green + no P2P regressions.
  const jestAfterFile = path.join(dumpDir, "jest-after.json");
  const after = runProjectTests({
    instance,
    targetDir: sandboxDir,
    outputFile: jestAfterFile,
    logger: log,
  });
  record("L9-f2p-green", evaluateResolution(after.parsed, instance.failToPass));

  const allOk = checks.every((c) => c.ok);
  return finishRun({
    instance,
    opts,
    verdict: allOk ? "passed" : "failed",
    checks,
    dumpDir,
    sandboxDir,
    sessionId: session.id,
    invocationId: chatSummary.invocationId,
    chat: chatSummary,
  });
}

function finishRun({
  instance,
  opts,
  verdict,
  checks,
  dumpDir,
  sandboxDir,
  sessionId,
  invocationId,
  chat,
}) {
  const result = {
    instanceId: instance.id,
    repo: instance.repo,
    baseCommit: instance.baseCommit,
    agent: opts.agent,
    verdict,
    sandboxDir,
    sessionId: sessionId || "",
    invocationId: invocationId || "",
    chat: chat || null,
    checks,
    artifacts: fs.existsSync(dumpDir) ? fs.readdirSync(dumpDir).map((f) => f) : [],
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
  const selected = opts.instance === "all" ? available : [opts.instance];
  for (const id of selected) {
    if (!available.includes(id)) {
      console.error(`unknown instance "${id}". available: ${available.join(", ")}`);
      process.exitCode = EXIT.PREFLIGHT;
      return;
    }
  }

  const preflightProblems = preflight(opts.agent);
  if (preflightProblems.length > 0) {
    for (const problem of preflightProblems) console.error(`preflight: ${problem}`);
    process.exitCode = EXIT.PREFLIGHT;
    return;
  }

  const dumpDir = createDumpDir(opts.dumpDir, "issue-fix");
  const harness = { dumpDir, api: null };
  const instances = selected.map((id) => loadInstance(id));

  if (!opts.dryRun) {
    const server = await startLiveServer({
      logger: (m) => console.log(`[server] ${m}`),
      shiftHome: path.join(dumpDir, "shift-home"),
      useDefaultHome: opts.useDefaultHome,
    });
    harness.api = createApiClient({ baseUrl: server.baseUrl, token: server.token });
    try {
      await runAll(instances, opts, harness);
    } finally {
      await server.close();
    }
  } else {
    await runAll(instances, opts, harness);
  }
}

async function runAll(instances, opts, harness) {
  let worst = EXIT.OK;
  for (const instance of instances) {
    let result;
    try {
      result = await runInstance({ instance, opts, harness });
    } catch (error) {
      result = finishRun({
        instance,
        opts,
        verdict: "error",
        checks: [{ name: "runner", ok: false, problems: [String(error?.message || error)] }],
        dumpDir: path.join(harness.dumpDir, instance.id),
        sandboxDir: "",
      });
    }
    if (result.verdict === "dry-run") continue;
    worst = Math.max(worst, exitCodeForVerdict(result.verdict));
  }
  if (worst !== EXIT.OK) process.exitCode = worst;
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = EXIT.HARD_FAIL;
});

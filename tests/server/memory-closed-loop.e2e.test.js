/**
 * End-to-end closed loop:
 *   handoff fence → memory_entries → A2A successor sees Memory Card
 *   → window-seal → next user turn bootstrap still injects memories
 *
 * Also asserts handoff-metrics SSE/log for capture + a2a_prompt_has_memory.
 */
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const { createServer } = require("../../src/server");
const { createStorage } = require("../../src/storage");

const UI_TOKEN = "memory-e2e-token";

function apiFetch(url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("X-Shift-UI-Token", UI_TOKEN);
  if (init.method === "POST") headers.set("content-type", "application/json");
  return fetch(url, { ...init, headers });
}

function spawnText(text) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  process.nextTick(() => {
    child.stdout.write(`${JSON.stringify({ type: "text.delta", text })}\n`);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
  });
  return child;
}

function successfulSpawn() {
  return spawnText("hello");
}

function worktreeManager() {
  return {
    getStatus() {
      throw new Error("No managed worktree");
    },
    getDiff() {
      return "";
    },
    discardWorktree() {
      throw new Error("No managed worktree");
    },
    stopAllPreviews() {},
  };
}

function parseSseMetrics(streamText) {
  const metrics = [];
  const blocks = String(streamText || "").split("\n\n");
  for (const block of blocks) {
    const eventMatch = block.match(/^event:\s*(.+)$/m);
    const dataMatch = block.match(/^data:\s*(.+)$/m);
    if (!eventMatch || !dataMatch) continue;
    if (eventMatch[1].trim() !== "handoff-metrics") continue;
    try {
      metrics.push(JSON.parse(dataMatch[1]));
    } catch {
      // ignore malformed
    }
  }
  return metrics;
}

test("memory closed loop e2e: handoff → inject → seal → bootstrap", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-closed-loop-"));
  const storage = createStorage({ file: ":memory:" });
  storage.metadata.activateCleanCutover();
  const prompts = [];
  const metricLogs = [];
  let run = 0;

  const server = createServer({
    sessionsFile: path.join(tmpDir, "sessions.json"),
    invocationsFile: path.join(tmpDir, "invocations.json"),
    storageMode: "sqlite",
    storage,
    logger: {
      info(line) {
        if (String(line).includes("[handoff-metrics]")) metricLogs.push(String(line));
      },
      log() {},
      error() {},
    },
    spawnRunner(_command, args) {
      const prompt = args[args.length - 1];
      prompts.push(prompt);
      run += 1;
      // First agent turn: structured A2A handoff to OpenCode.
      if (run === 1) {
        return spawnText(
          [
            "@OpenCode 请继续实现登录",
            "```handoff",
            "to: opencode",
            "goal: 完成登录流程",
            "what: 接口设计已完成 dual-loop-e2e-token",
            "why: 保持兼容",
            "next_action: 实现并测试",
            "files:",
            "  - src/login.js",
            "```",
          ].join("\n")
        );
      }
      // A2A successor + later turns.
      return successfulSpawn();
    },
    worktreeManager: worktreeManager(),
    uiToken: UI_TOKEN,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const { session } = await apiFetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: "{}",
    }).then((response) => response.json());

    // --- Step 1–2: handoff → memory_entries + A2A inject ---
    const chat1 = await apiFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: session.id,
        agent: "codex",
        prompt: "开始 dual-loop e2e",
      }),
    }).then((response) => response.text());

    assert.equal(run, 2, "expected A2A successor to run");
    const memoriesAfterHandoff = storage.memories.listForThread(session.id);
    const handoffMemories = memoriesAfterHandoff.filter((m) => m.kind === "handoff");
    assert.equal(handoffMemories.length, 1);
    assert.match(handoffMemories[0].content, /dual-loop-e2e-token|接口设计已完成/);
    assert.equal(handoffMemories[0].metadata?.quality?.ok, true);

    // A2A successor prompt must include non-empty Active Memories with the handoff.
    const a2aPrompt = prompts[1];
    assert.match(a2aPrompt, /<!-- Active Memories \([1-9]\d*\) -->/);
    assert.match(a2aPrompt, /\[captured\]\[handoff\]/);
    assert.match(a2aPrompt, /dual-loop-e2e-token|接口设计已完成/);
    assert.match(a2aPrompt, /Structured Handoff|交接包完整度: ok/);

    const metrics1 = parseSseMetrics(chat1);
    const finalizeMetrics = metrics1.find((m) => m.kind === "finalize");
    const injectMetrics = metrics1.find((m) => m.kind === "a2a_inject");
    assert.ok(finalizeMetrics, "expected finalize handoff-metrics SSE");
    assert.equal(finalizeMetrics.targets, 1);
    assert.equal(finalizeMetrics.captured, 1);
    assert.equal(finalizeMetrics.capture_rate, 1);
    assert.equal(finalizeMetrics.ok_rate, 1);
    assert.ok(injectMetrics, "expected a2a_inject handoff-metrics SSE");
    assert.equal(injectMetrics.a2a_prompt_has_memory, 1);
    assert.ok(injectMetrics.prompt_bytes > 0);
    assert.deepEqual(metricLogs, [], "handoff metrics should be silent in the terminal by default");

    // Search must surface the memory layer hit.
    const search = await apiFetch(
      `${baseUrl}/api/callbacks/session-search?sessionId=${session.id}&query=${encodeURIComponent(
        "dual-loop-e2e-token"
      )}&layers=memory`
    ).then((response) => response.json());
    assert.ok(
      search.hits?.some((hit) => hit.layer === "memory" || hit.sourceKind === "memory-entry")
    );

    // --- Step 3: force seal and capture window-seal ---
    const firstWindow = storage.windows.listForThread(session.id)[0];
    assert.ok(firstWindow, "expected a context window");
    const targetChars = Math.floor(firstWindow.capacityTokens * 4 * 0.895);
    const persistedChars = firstWindow.inputChars + firstWindow.outputChars;
    storage.windows.addUsage(firstWindow.id, {
      inputChars: Math.max(0, targetChars - persistedChars),
    });
    storage.windows.bindProviderSession(firstWindow.id, "provider-session-old");

    const chat2 = await apiFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: session.id,
        agent: "codex",
        prompt: "second turn force seal",
      }),
    }).then((response) => response.text());
    assert.match(chat2, /event: sealed/);
    assert.equal(storage.windows.get(firstWindow.id).state, "sealed");
    const activeWindow = storage.windows
      .listForThread(session.id)
      .find((window) => window.state === "active");
    assert.equal(activeWindow.providerSessionId, null);

    const sealMemories = storage.memories
      .listForThread(session.id)
      .filter((memory) => memory.kind === "window-seal");
    assert.ok(sealMemories.length >= 1, "expected window-seal memory after force seal");
    assert.ok(
      sealMemories.some((m) => m.captureKey === `window-seal:${firstWindow.id}`),
      "expected seal memory for first window"
    );
    assert.match(chat2, /event: memory-captured/);

    // --- Step 4: next bootstrap still injects memories (handoff and/or seal) ---
    await apiFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: session.id,
        agent: "codex",
        prompt: "third turn after seal",
      }),
    }).then((response) => response.text());

    const postSealBootstrap = prompts[prompts.length - 1];
    assert.match(postSealBootstrap, /<!-- Active Memories \([1-9]\d*\) -->/);
    assert.match(postSealBootstrap, /\[captured\]\[window-seal\]|\[captured\]\[handoff\]/);
    assert.match(postSealBootstrap, /partial=true|dual-loop-e2e-token|接口设计已完成/);
    assert.match(postSealBootstrap, /Generation: 2/);

    // Both kinds should still be durable in SQLite.
    const all = storage.memories.listForThread(session.id);
    assert.ok(all.some((m) => m.kind === "handoff"));
    assert.ok(all.some((m) => m.kind === "window-seal"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const { createServer } = require("../../src/server");
const { createStorage } = require("../../src/storage");
const { buildAssistantFinalMessage } = require("../../src/server/chat-worklist");

const UI_TOKEN = "failed-assistant-token";

function apiFetch(url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("X-Shift-UI-Token", UI_TOKEN);
  if (init.method === "POST") headers.set("content-type", "application/json");
  return fetch(url, { ...init, headers });
}

function spawnTextThenSignal(text, signal = "SIGTERM") {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  process.nextTick(() => {
    child.stdout.write(`${JSON.stringify({ type: "text.delta", text })}\n`);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", null, signal);
  });
  return child;
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
      return { ok: true };
    },
    stopAllPreviews() {},
  };
}

test("buildAssistantFinalMessage skips empty failed replies", () => {
  assert.equal(
    buildAssistantFinalMessage({
      agent: "codex",
      content: "   ",
      invocationId: "inv-1",
    }),
    null
  );
  const message = buildAssistantFinalMessage({
    agent: "codex",
    content: "review body",
    invocationId: "inv-1",
    signal: "SIGTERM",
  });
  assert.equal(message.messageType, "assistant-final");
  assert.equal(message.content, "review body");
  assert.equal(message.signal, "SIGTERM");
});

test("failed provider runs persist streamed assistant text", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "failed-assistant-"));
  const storage = createStorage({ file: ":memory:" });
  storage.metadata.activateCleanCutover();
  const projectKey = storage.projects.openDirectory(tmpDir).projectKey;
  const server = createServer({
    availabilityProbe: async () => ({ status: "unknown", reason: null }),
    storageMode: "sqlite",
    storage,
    spawnRunner: () => spawnTextThenSignal("初审结论：方向合理"),
    worktreeManager: worktreeManager(),
    uiToken: UI_TOKEN,
    logger: { info() {}, log() {}, error() {}, warn() {} },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const { session } = await apiFetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: JSON.stringify({ projectKey }),
    }).then((r) => r.json());

    await apiFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: session.id,
        agent: "codex",
        prompt: "审查当前分支",
      }),
    }).then((r) => r.text());

    const msgRes = await apiFetch(`${baseUrl}/api/messages?sessionId=${session.id}`).then((r) =>
      r.json()
    );
    const assistants = (msgRes.messages || []).filter((m) => m.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].content, "初审结论：方向合理");
    const invocations = storage.invocations.listForThread(session.id);
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].state, "failed");
    assert.equal(invocations[0].signal, "SIGTERM");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await server.closeStorageContext?.();
    storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

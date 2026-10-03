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
const { createChatRuntime } = require("../../src/server/chat-runtime");
const { startSessionRun, collectSessionEvents } = require("../helpers/chat-run-client");

const UI_TOKEN = "run-events-token";

function apiFetch(url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("X-Shift-UI-Token", UI_TOKEN);
  if (init.method === "POST") headers.set("content-type", "application/json");
  return fetch(url, { ...init, headers });
}

function delayedSpawn(text, started) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.emit("close", null, "SIGTERM");
      return true;
    };
    started.push(child);
    setTimeout(() => {
      child.stdout.write(`${JSON.stringify({ type: "text.delta", text })}\n`);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0, null);
    }, 80);
    return child;
  };
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

async function withRunServer(spawnRunner, fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-events-"));
  const storage = createStorage({ file: ":memory:" });
  storage.metadata.activateCleanCutover();
  const projectKey = storage.projects.openDirectory(tmpDir).projectKey;
  const server = createServer({
    availabilityProbe: async () => ({ status: "unknown", reason: null }),
    storageMode: "sqlite",
    storage,
    spawnRunner,
    worktreeManager: worktreeManager(),
    uiToken: UI_TOKEN,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await apiFetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: JSON.stringify({ projectKey }),
    }).then((response) => response.json());
    await fn({ baseUrl, sessionId: created.session.id, storage, server });
  } finally {
    const closed =
      typeof server.shutdown === "function"
        ? server.shutdown()
        : Promise.all([
            new Promise((resolve) => server.close(resolve)),
            server.closeStorageContext?.(),
          ]);
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 8000))]);
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function parseSseIds(text) {
  return [...text.matchAll(/^id: (\d+)/gm)].map((match) => Number(match[1]));
}

async function collectEventsUntil(baseUrl, sessionId, predicate, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await apiFetch(`${baseUrl}/api/sessions/${sessionId}/events`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        break;
      }
      const { value, done } = chunk;
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (predicate(text)) {
        try {
          await reader.cancel();
        } catch {
          // observer disconnect
        }
        break;
      }
    }
    return text;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

test("closing the event stream does not abort the backend run", async () => {
  const started = [];
  await withRunServer(
    delayedSpawn("kept-running", started),
    async ({ baseUrl, sessionId, storage }) => {
      const start = await startSessionRun(
        baseUrl,
        { sessionId, agent: "codex", prompt: "keep going" },
        { headers: { "X-Shift-UI-Token": UI_TOKEN }, fetch }
      );
      assert.equal(start.status, 202);
      const { traceId } = await start.json();
      const controller = new AbortController();
      const first = collectSessionEvents(baseUrl, sessionId, {
        headers: { "X-Shift-UI-Token": UI_TOKEN },
        fetch,
        signal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();
      await first.catch(() => {});
      assert.equal(started.length, 1);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const invocations = storage.invocations.listForThread(sessionId);
      assert.ok(invocations.some((row) => row.state === "completed"));
      assert.ok(traceId);
      const trace = storage.traces.get(traceId);
      assert.equal(trace.state, "completed");
      assert.equal(trace.failureStage, null);
      assert.equal(trace.errorCode, null);
      const replay = storage.invocations.listEventsAfter(sessionId, 0);
      assert.ok(replay.length > 0);
      assert.ok(replay.every((event) => event.traceId === traceId));
    }
  );
});

test("explicit Stop aborts only the matching trace", async () => {
  const started = [];
  await withRunServer(delayedSpawn("stop-me", started), async ({ baseUrl, sessionId }) => {
    const start = await startSessionRun(
      baseUrl,
      { sessionId, agent: "codex", prompt: "stop me" },
      { headers: { "X-Shift-UI-Token": UI_TOKEN }, fetch }
    );
    assert.equal(start.status, 202);
    const { traceId } = await start.json();
    assert.ok(traceId);
    const staleResponse = await apiFetch(
      `${baseUrl}/api/sessions/${sessionId}/runs/trace_not_this_one/stop`,
      { method: "POST" }
    );
    assert.equal(staleResponse.status, 200);
    const stale = await staleResponse.json();
    assert.equal(stale.stopped, false);
    const stoppedResponse = await apiFetch(
      `${baseUrl}/api/sessions/${sessionId}/runs/${traceId}/stop`,
      { method: "POST" }
    );
    assert.equal(stoppedResponse.status, 200);
    const stopped = await stoppedResponse.json();
    assert.equal(stopped.stopped, true);
  });
});

test("POST /api/chat is no longer an online entry", async () => {
  await withRunServer(delayedSpawn("gone", []), async ({ baseUrl, sessionId }) => {
    const response = await apiFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify({ sessionId, agent: "codex", prompt: "old path" }),
    });
    assert.equal(response.status, 404);
  });
});

test("event replay pages past the old 2000-event cap", async () => {
  await withRunServer(delayedSpawn("unused", []), async ({ baseUrl, sessionId, storage }) => {
    const window = storage.windows.create({
      id: `window-${sessionId}`,
      threadId: sessionId,
      agentId: "codex",
      providerKey: "codex:gpt",
      workspaceKey: `base:${sessionId}`,
      generation: 1,
      capacityTokens: 1000,
    });
    storage.invocations.start({
      id: `inv-${sessionId}`,
      threadId: sessionId,
      windowId: window.id,
      agentId: "codex",
    });
    const total = 2105;
    for (let index = 0; index < total; index += 1) {
      storage.invocations.appendEvent({
        invocationId: `inv-${sessionId}`,
        kind: "text.delta",
        payload: { text: `#${index}` },
      });
    }
    const snapshot = storage.executions.runSnapshot(sessionId);
    assert.ok(snapshot.lastEventId > 0);
    const text = await collectEventsUntil(
      baseUrl,
      sessionId,
      (chunk) => parseSseIds(chunk).includes(snapshot.lastEventId),
      8000
    );
    const ids = parseSseIds(text);
    assert.ok(ids.length >= total, `expected at least ${total} replayed ids, got ${ids.length}`);
    assert.equal(ids.at(-1), snapshot.lastEventId);
    assert.ok(text.includes(`#${total - 1}`));
    assert.ok(text.includes("#2000"));
  });
});

test("background execution errors publish a durable terminal", async () => {
  await withRunServer(
    () => {
      throw new Error("spawn exploded");
    },
    async ({ baseUrl, sessionId, storage }) => {
      const start = await startSessionRun(
        baseUrl,
        { sessionId, agent: "codex", prompt: "boom" },
        { headers: { "X-Shift-UI-Token": UI_TOKEN }, fetch }
      );
      assert.equal(start.status, 202);
      const text = await collectSessionEvents(baseUrl, sessionId, {
        headers: { "X-Shift-UI-Token": UI_TOKEN },
        fetch,
      }).then((result) => result.text);
      assert.match(text, /run\.failed|spawn exploded/);
      const invocations = storage.invocations.listForThread(sessionId);
      assert.ok(invocations.length > 0);
      assert.ok(invocations.every((row) => row.state !== "active"));
      const snapshot = storage.executions.runSnapshot(sessionId);
      assert.equal(snapshot.runStatus, "failed");
    }
  );
});

test("shutdown closes SSE subscribers and does not hang", async () => {
  await withRunServer(delayedSpawn("unused", []), async ({ baseUrl, sessionId, server }) => {
    const response = await apiFetch(`${baseUrl}/api/sessions/${sessionId}/events`, {
      headers: { accept: "text/event-stream" },
    });
    assert.equal(response.status, 200);
    const started = Date.now();
    await Promise.race([
      server.shutdown(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("shutdown timed out with an open SSE")), 5000)
      ),
    ]);
    assert.ok(Date.now() - started < 5000);
  });
});

test("runtime shutdown closes subscribers and rejects new runs", async () => {
  const runtime = createChatRuntime();
  let closed = 0;
  runtime.subscribe("s1", {
    onEvent() {},
    close() {
      closed += 1;
    },
  });
  runtime.attachExecutor({
    async startRun() {
      return { status: 202, json: { ok: true } };
    },
  });
  await runtime.shutdown();
  assert.equal(closed, 1);
  const rejected = await runtime.startRun({ body: {} });
  assert.equal(rejected.status, 503);
});

test("timer write failure closes the invocation as failed instead of silently succeeding", async () => {
  await withRunServer(
    () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {
        child.emit("close", null, "SIGTERM");
        return true;
      };
      setTimeout(
        () => child.stdout.write(JSON.stringify({ type: "text.delta", text: "retained" }) + "\n"),
        10
      );
      setTimeout(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      }, 250);
      return child;
    },
    async ({ baseUrl, sessionId, storage }) => {
      const append = storage.invocations.appendEvent.bind(storage.invocations);
      let injected = false;
      storage.invocations.appendEvent = (input) => {
        if (input.kind === "text.delta" && !injected) {
          injected = true;
          throw new Error("timer persistence fault");
        }
        return append(input);
      };
      const response = await startSessionRun(
        baseUrl,
        { sessionId, agent: "codex", prompt: "timer fault" },
        { headers: { "X-Shift-UI-Token": UI_TOKEN }, fetch }
      );
      assert.equal(response.status, 202);
      const { traceId } = await response.json();
      await collectSessionEvents(baseUrl, sessionId, {
        traceId,
        headers: { "X-Shift-UI-Token": UI_TOKEN },
        fetch,
      });
      assert.equal(injected, true);
      const rows = storage.invocations.listForThread(sessionId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].state, "failed");
      assert.equal(rows[0].terminalReason, "stream-handler-failed");
    }
  );
});

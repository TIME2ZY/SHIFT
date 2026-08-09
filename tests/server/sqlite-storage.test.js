const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const { createServer } = require("../../src/server");
const { createStorage } = require("../../src/storage");
const { prepareCleanEpoch } = require("../../src/storage/offline/clean-epoch");

const UI_TOKEN = "sqlite-storage-test-token";
const projectKeysByOrigin = new Map();

function apiFetch(url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("X-Shift-UI-Token", UI_TOKEN);
  if (init.method === "POST") headers.set("content-type", "application/json");
  const parsedUrl = new URL(url);
  const projectKey = projectKeysByOrigin.get(parsedUrl.origin);
  let target = url;
  let body = init.body;
  if (projectKey && init.method === "POST" && parsedUrl.pathname === "/api/sessions") {
    body = JSON.stringify({ ...(body ? JSON.parse(body) : {}), projectKey });
  }
  if (
    projectKey &&
    (!init.method || init.method === "GET") &&
    parsedUrl.pathname === "/api/sessions"
  ) {
    target = `${parsedUrl.origin}/api/projects/${encodeURIComponent(projectKey)}/sessions`;
  }
  return fetch(target, { ...init, headers, ...(body !== undefined ? { body } : {}) });
}

function successfulSpawn() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  process.nextTick(() => {
    child.stdout.write(`${JSON.stringify({ type: "text.delta", text: "hello" })}\n`);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
  });
  return child;
}

function providerSessionSpawn(calls, responseTexts = []) {
  return (_command, _args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    const sessionId = `provider-session-${calls.length + 1}`;
    calls.push({
      resumeSessionId: options.env.INVOKE_SESSION_ID || "",
      sessionFile: options.env.INVOKE_SESSION_FILE || "",
      sessionId,
      prompt: _args[_args.length - 1],
    });
    process.nextTick(() => {
      child.stdout.write(`${JSON.stringify({ type: "run.started", sessionId })}\n`);
      child.stdout.write(
        `${JSON.stringify({
          type: "text.delta",
          text: responseTexts[calls.length - 1] || "hello",
        })}\n`
      );
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  };
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

test("sqlite server ignores the retired online transcript path override", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-audit-boundary-"));
  const databaseFile = path.join(tmpDir, "shift.sqlite");
  const transcriptDir = path.join(tmpDir, "transcripts");
  const previousTranscriptDir = process.env.SHIFT_TRANSCRIPT_DIR;
  prepareCleanEpoch({ file: databaseFile });
  process.env.SHIFT_TRANSCRIPT_DIR = transcriptDir;
  let server;
  try {
    server = createServer({
      storageMode: "sqlite",
      memoryDbFile: databaseFile,
      auditTranscriptDir: transcriptDir,
      worktreeManager: worktreeManager(),
      uiToken: UI_TOKEN,
    });
    assert.ok(server);
  } finally {
    await server?.closeStorageContext();
    if (previousTranscriptDir === undefined) delete process.env.SHIFT_TRANSCRIPT_DIR;
    else process.env.SHIFT_TRANSCRIPT_DIR = previousTranscriptDir;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test("chat reads and writes thread state only through SQLite", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dual-write-server-"));
  const previousTranscriptDir = process.env.SHIFT_TRANSCRIPT_DIR;
  process.env.SHIFT_TRANSCRIPT_DIR = path.join(tmpDir, "transcripts");
  const storage = createStorage({ file: ":memory:" });
  storage.metadata.activateCleanCutover();
  const projectKey = storage.projects.openDirectory(tmpDir).projectKey;
  const server = createServer({
    sessionsFile: path.join(tmpDir, "sessions.json"),
    invocationsFile: path.join(tmpDir, "invocations.json"),
    sessionMapRoot: path.join(tmpDir, "session-maps"),
    storageMode: "sqlite",
    storage,
    spawnRunner: successfulSpawn,
    worktreeManager: worktreeManager(),
    uiToken: UI_TOKEN,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  projectKeysByOrigin.set(baseUrl, projectKey);

  try {
    const createdResponse = await apiFetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: "{}",
    });
    const { session } = await createdResponse.json();

    const chatResponse = await apiFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify({ sessionId: session.id, agent: "codex", prompt: "Hi" }),
    });
    await chatResponse.text();

    const durableMessages = await apiFetch(`${baseUrl}/api/messages?sessionId=${session.id}`).then(
      (response) => response.json()
    );
    assert.deepEqual(
      durableMessages.messages.map((message) => message.content),
      ["Hi", "hello"]
    );
    assert.equal(fs.existsSync(path.join(tmpDir, "sessions.json")), false);
    assert.equal(fs.existsSync(path.join(tmpDir, "invocations.json")), false);
    assert.equal(fs.existsSync(path.join(tmpDir, "session-maps")), false);
    assert.equal(storage.threads.list().length, 1);
    assert.equal(storage.windows.listForThread(session.id).length, 1);
    assert.equal(storage.messages.listForThread(session.id).length, 2);
    assert.equal(storage.invocations.listForThread(session.id).length, 1);
    assert.deepEqual(
      storage.invocations
        .listEvents(storage.invocations.listForThread(session.id)[0].id)
        .map((event) => event.kind),
      ["invocation-start", "text.delta", "invocation-end"]
    );

    const invocationId = storage.invocations.listForThread(session.id)[0].id;
    const replay = await apiFetch(
      `${baseUrl}/api/callbacks/read-invocation?sessionId=${session.id}&targetInvocationId=${invocationId}`
    ).then((response) => response.json());
    assert.deepEqual(
      replay.events.map((event) => event.kind),
      ["invocation-start", "text.delta", "invocation-end"]
    );

    // Legacy transcript state is absent; search still comes from SQLite projections.
    const search = await apiFetch(
      `${baseUrl}/api/callbacks/session-search?sessionId=${session.id}&query=hello`
    ).then((response) => response.json());
    assert.equal(search.hits.length, 1);
    assert.equal(search.hits[0].kind, "text.delta");

    const userSearch = await apiFetch(
      `${baseUrl}/api/callbacks/session-search?sessionId=${session.id}&query=Hi`
    ).then((response) => response.json());
    const userHit = userSearch.hits.find((hit) => hit.sourceKind === "message");
    assert.ok(userHit);
    assert.equal(userHit.kind, "message.user");

    const deleteResponse = await apiFetch(`${baseUrl}/api/sessions/${session.id}`, {
      method: "DELETE",
    });
    assert.equal(deleteResponse.status, 200);
    // Default delete archives the thread (hidden) without purging L0 evidence.
    assert.equal(storage.threads.list().length, 0);
    assert.ok(
      storage.db.prepare("SELECT COUNT(*) AS count FROM invocation_events").get().count > 0
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await server.closeStorageContext?.();
    storage.close();
    if (previousTranscriptDir === undefined) delete process.env.SHIFT_TRANSCRIPT_DIR;
    else process.env.SHIFT_TRANSCRIPT_DIR = previousTranscriptDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("routed structured handoff is collaboration evidence, not product Memory", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-memory-server-"));
  const storage = createStorage({ file: ":memory:" });
  storage.metadata.activateCleanCutover();
  const projectKey = storage.projects.openDirectory(tmpDir).projectKey;
  let run = 0;
  const server = createServer({
    sessionsFile: path.join(tmpDir, "sessions.json"),
    invocationsFile: path.join(tmpDir, "invocations.json"),
    sessionMapRoot: path.join(tmpDir, "session-maps"),
    storageMode: "sqlite",
    storage,
    spawnRunner() {
      run += 1;
      if (run === 1) {
        return spawnText(
          [
            "@OpenCode 请继续实现\n",
            "```handoff\n",
            "to: opencode\n",
            "goal: 完成登录流程\n",
            "what: 接口设计已完成\n",
            "why: 保持兼容\n",
            "next_action: 实现并测试\n",
            "```",
          ].join("")
        );
      }
      return spawnText("已完成");
    },
    worktreeManager: worktreeManager(),
    uiToken: UI_TOKEN,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  projectKeysByOrigin.set(baseUrl, projectKey);

  try {
    const { session } = await apiFetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: "{}",
    }).then((response) => response.json());
    const stream = await apiFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify({ sessionId: session.id, agent: "codex", prompt: "start" }),
    }).then((response) => response.text());
    const memories = storage.memories.listForThread(session.id);

    assert.equal(run, 2);
    assert.equal(memories.length, 0);
    assert.match(stream, /event: handoff-captured/);
    const search = await apiFetch(
      `${baseUrl}/api/callbacks/session-search?sessionId=${session.id}&query=${encodeURIComponent("登录流程")}`
    ).then((response) => response.json());
    const memoryHit = search.hits.find((hit) => hit.sourceKind === "memory-entry");
    assert.equal(memoryHit, undefined);
    assert.ok(search.hits.some((hit) => hit.layer === "evidence"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await server.closeStorageContext?.();
    storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("chat seals from cumulative window usage and starts the next generation", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "window-runtime-server-"));
  const storage = createStorage({ file: ":memory:" });
  storage.metadata.activateCleanCutover();
  const projectKey = storage.projects.openDirectory(tmpDir).projectKey;
  const prompts = [];
  const server = createServer({
    sessionsFile: path.join(tmpDir, "sessions.json"),
    invocationsFile: path.join(tmpDir, "invocations.json"),
    storageMode: "sqlite",
    storage,
    spawnRunner(_command, args) {
      prompts.push(args[args.length - 1]);
      return successfulSpawn();
    },
    worktreeManager: worktreeManager(),
    uiToken: UI_TOKEN,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  projectKeysByOrigin.set(baseUrl, projectKey);

  try {
    const { session } = await apiFetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: "{}",
    }).then((response) => response.json());

    await apiFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify({ sessionId: session.id, agent: "codex", prompt: "first" }),
    }).then((response) => response.text());

    const firstWindow = storage.windows.listForThread(session.id)[0];
    const targetChars = Math.floor(firstWindow.capacityTokens * 4 * 0.895);
    const persistedChars = firstWindow.inputChars + firstWindow.outputChars;
    storage.windows.addUsage(firstWindow.id, {
      inputChars: Math.max(0, targetChars - persistedChars),
    });
    storage.windows.bindProviderSession(firstWindow.id, "provider-session-old");

    const sealedStream = await apiFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify({ sessionId: session.id, agent: "codex", prompt: "second" }),
    }).then((response) => response.text());
    assert.match(sealedStream, /event: sealed/);
    assert.equal(storage.windows.get(firstWindow.id).state, "sealed");
    const rotatedWindows = storage.windows.listForThread(session.id);
    assert.equal(rotatedWindows.length, 2);
    assert.equal(rotatedWindows[1].generation, 2);
    assert.equal(rotatedWindows[1].state, "active");
    assert.equal(rotatedWindows[1].providerSessionId, null);
    // PRE-call rotate may seal before provider output; generation still advances.
    const sealedWin = storage.windows.get(firstWindow.id);
    assert.equal(sealedWin.state, "sealed");
    assert.equal(storage.memories.listForThread(session.id).length, 0);
    assert.match(sealedStream, /event: window-sealed/);

    await apiFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify({ sessionId: session.id, agent: "codex", prompt: "third" }),
    }).then((response) => response.text());
    const windows = storage.windows.listForThread(session.id);
    assert.equal(windows.length, 2);
    assert.equal(windows[1].generation, 2);
    assert.match(prompts[2], /Generation: 2/);
    assert.match(prompts[2], /<!-- Active Memories \(0\) -->/);
    assert.doesNotMatch(prompts[2], /\[window-seal\]/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await server.closeStorageContext?.();
    storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("default sqlite mode restores sessions after restart without legacy writes", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-primary-server-"));
  const sessionsFile = path.join(tmpDir, "sessions.json");
  const memoryDbFile = path.join(tmpDir, "memory.sqlite");
  const transcriptDir = path.join(tmpDir, "transcripts");
  const previousTranscriptDir = process.env.SHIFT_TRANSCRIPT_DIR;
  process.env.SHIFT_TRANSCRIPT_DIR = transcriptDir;
  const providerCalls = [];
  const firstConclusion = "结论：SQLite restart context survives。";
  prepareCleanEpoch({ file: memoryDbFile });
  const seedStorage = createStorage({ file: memoryDbFile });
  const projectKey = seedStorage.projects.openDirectory(tmpDir).projectKey;
  seedStorage.close();

  function startServer() {
    const server = createServer({
      sessionsFile,
      invocationsFile: path.join(tmpDir, "invocations.json"),
      sessionMapRoot: path.join(tmpDir, "session-maps"),
      memoryDbFile,
      spawnRunner: providerSessionSpawn(providerCalls, [firstConclusion, "hello"]),
      worktreeManager: worktreeManager(),
      uiToken: UI_TOKEN,
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
  }

  let firstServer;
  let secondServer;
  try {
    firstServer = await startServer();
    const firstUrl = `http://127.0.0.1:${firstServer.address().port}`;
    projectKeysByOrigin.set(firstUrl, projectKey);
    const { session } = await apiFetch(`${firstUrl}/api/sessions`, {
      method: "POST",
      body: "{}",
    }).then((response) => response.json());
    await apiFetch(`${firstUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: session.id,
        agent: "codex",
        prompt: "durable first prompt",
      }),
    }).then((response) => response.text());
    assert.equal(
      fs.existsSync(path.join(tmpDir, "invocations.json")),
      false,
      "sqlite mode must not create the legacy invocation registry"
    );
    assert.equal(providerCalls[0].resumeSessionId, "");
    assert.equal(providerCalls[0].sessionFile, "");
    assert.equal(fs.existsSync(path.join(tmpDir, "session-maps")), false);
    await new Promise((resolve) => firstServer.close(resolve));
    await firstServer.closeStorageContext?.();
    firstServer = null;

    fs.rmSync(sessionsFile, { force: true });
    fs.rmSync(transcriptDir, { recursive: true, force: true });

    secondServer = await startServer();
    const secondUrl = `http://127.0.0.1:${secondServer.address().port}`;
    projectKeysByOrigin.set(secondUrl, projectKey);
    const sessions = await apiFetch(`${secondUrl}/api/sessions`).then((response) =>
      response.json()
    );
    assert.equal(sessions.sessions.length, 1);
    assert.equal(sessions.sessions[0].id, session.id);
    assert.equal(sessions.sessions[0].messageCount, 2);

    const recovered = await apiFetch(`${secondUrl}/api/messages?sessionId=${session.id}`).then(
      (response) => response.json()
    );
    assert.deepEqual(
      recovered.messages.map((message) => message.content),
      ["durable first prompt", firstConclusion]
    );

    await apiFetch(`${secondUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: session.id,
        agent: "codex",
        prompt: "continued after restart",
      }),
    }).then((response) => response.text());
    assert.equal(providerCalls[1].resumeSessionId, "provider-session-1");
    assert.equal(providerCalls[1].sessionFile, "");
    assert.match(providerCalls[1].prompt, /SQLite restart context survives/);
    assert.match(providerCalls[1].prompt, /SHIFT_DERIVED_DIGEST_DATA/);
    assert.equal(fs.existsSync(path.join(tmpDir, "session-maps")), false);
    const continued = await apiFetch(`${secondUrl}/api/messages?sessionId=${session.id}`).then(
      (response) => response.json()
    );
    assert.deepEqual(
      continued.messages.map((message) => message.content),
      ["durable first prompt", firstConclusion, "continued after restart", "hello"]
    );
    // sqlite mode is true single-write: no sessions.json / transcript resurrection.
    assert.equal(fs.existsSync(sessionsFile), false);
    assert.equal(fs.existsSync(transcriptDir), false);

    const recall = await apiFetch(
      `${secondUrl}/api/callbacks/session-search?sessionId=${session.id}&query=durable%20first`
    ).then((response) => response.json());
    assert.ok(recall.hits.some((hit) => hit.kind === "message.user"));

    // Causal fields are populated for user-triggered turns.
    const { createStorage } = require("../../src/storage");
    const storage = createStorage({ file: memoryDbFile });
    try {
      const invocations = storage.invocations.listForThread(session.id);
      assert.ok(invocations.length >= 2);
      assert.ok(invocations.every((item) => item.triggerType === "user-message"));
      assert.ok(invocations.every((item) => typeof item.triggerMessageId === "string"));
    } finally {
      storage.close();
    }
  } finally {
    if (firstServer) {
      await new Promise((resolve) => firstServer.close(resolve));
      await firstServer.closeStorageContext?.();
    }
    if (secondServer) {
      await new Promise((resolve) => secondServer.close(resolve));
      await secondServer.closeStorageContext?.();
    }
    if (previousTranscriptDir === undefined) delete process.env.SHIFT_TRANSCRIPT_DIR;
    else process.env.SHIFT_TRANSCRIPT_DIR = previousTranscriptDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

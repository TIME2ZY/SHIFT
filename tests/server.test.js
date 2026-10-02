const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createServer } = require("../src/server/index");
const { parseA2AMentions } = require("../src/agents/routing");
const callbacks = require("../src/agents/callbacks");
const { createCollabTaskRegistry } = require("../src/agents/collab-task-registry");
const { createStorage } = require("../src/storage");
const { normalizeCanonicalPath } = require("../src/storage/project-identity");
const { prepareCleanEpoch } = require("../src/storage/offline/clean-epoch");
const { initializeCatalogSeats } = require("../src/agents/duty-routing");
const { AGENTS, resetAgentCatalog } = require("../src/agents/catalog");
const { createRuntimePaths } = require("../src/shared/runtime-paths");
const { startAndCollect, closeTestServer } = require("./helpers/chat-run-client");

const TEST_UI_TOKEN = "test-ui-token";
const nativeFetch = globalThis.fetch.bind(globalThis);
const projectKeysByOrigin = new Map();

async function fetch(input, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("X-Shift-UI-Token", TEST_UI_TOKEN);
  const method = String(init.method || "GET").toUpperCase();
  let body = init.body;
  if (["POST", "PUT", "PATCH"].includes(method) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
    if (body === undefined) body = "{}";
  }
  return nativeFetch(input, { ...init, headers, ...(body !== undefined ? { body } : {}) });
}

function startChat(baseUrl, body, init = {}) {
  return startAndCollect(baseUrl, body, { ...init, fetch });
}

async function createProjectSession(baseUrl, input = {}) {
  const projectKey = projectKeysByOrigin.get(new URL(baseUrl).origin);
  assert.ok(projectKey, `No Project fixture registered for ${baseUrl}`);
  return fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    body: JSON.stringify({ ...input, projectKey }),
  });
}

async function openProjectSession(baseUrl, projectDir) {
  const opened = await fetch(`${baseUrl}/api/projects/open`, {
    method: "POST",
    body: JSON.stringify({ dir: projectDir }),
  }).then((response) => response.json());
  return fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    body: JSON.stringify({ projectKey: opened.project.projectKey }),
  });
}

async function chatInNewProjectSession(baseUrl, init = {}) {
  const body = init.body ? JSON.parse(String(init.body)) : {};
  assert.equal(body.sessionId, undefined, "chat fixture already has a Session");
  const created = await createProjectSession(baseUrl).then((response) => response.json());
  return startChat(baseUrl, { ...body, sessionId: created.session.id }, init);
}

function createMockChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

function createPassthroughWorktreeManager() {
  return {
    ensureWorktree({ baseDir, sessionId }) {
      return {
        sessionId,
        baseDir,
        worktreeDir: baseDir,
        branch: `codex/session-${sessionId}`,
        status: "active",
        createdAt: new Date().toISOString(),
      };
    },
    getStatus(sessionId) {
      return { sessionId, branch: `codex/session-${sessionId}`, clean: true, porcelain: [] };
    },
    getDiff() {
      return "";
    },
    discardWorktree(sessionId) {
      return { ok: true, sessionId };
    },
  };
}

async function withServer(options, fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "invoke-server-test-"));
  const initialSessionIds = Array.isArray(options.initialSessionIds)
    ? options.initialSessionIds
    : [];
  const serverOptions = { ...options };
  delete serverOptions.initialSessionIds;
  const patchStorage = serverOptions.patchStorage;
  delete serverOptions.patchStorage;
  const memoryDbFile = path.join(tmpDir, "shift.sqlite");
  prepareCleanEpoch({ file: memoryDbFile });
  let projectKey;
  const storage = createStorage({ file: memoryDbFile });
  try {
    const project = storage.projects.openDirectory(tmpDir);
    projectKey = project.projectKey;
    for (const sessionId of initialSessionIds) {
      const session = storage.threads.create({ id: sessionId, project });
      initializeCatalogSeats(storage.threadSeats, sessionId, AGENTS, {
        createdAt: session.createdAt,
      });
    }
  } finally {
    storage.close();
  }
  const prevTranscriptDir = process.env.SHIFT_TRANSCRIPT_DIR;
  if (!prevTranscriptDir) {
    process.env.SHIFT_TRANSCRIPT_DIR = path.join(tmpDir, "transcripts");
  }
  let liveStorage = null;
  try {
    if (typeof patchStorage === "function") {
      liveStorage = createStorage({ file: memoryDbFile });
      patchStorage(liveStorage);
      serverOptions.storage = liveStorage;
    }
    const server = createServer({
      availabilityProbe: async (id) => ({
        status: id === "codex" ? "available" : "unavailable",
        reason: null,
      }),
      memoryDbFile,
      worktreeManager: options.worktreeManager || createPassthroughWorktreeManager(),
      uiToken: TEST_UI_TOKEN,
      ...serverOptions,
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    projectKeysByOrigin.set(origin, projectKey);
    try {
      await fn(origin, { memoryDbFile, projectKey });
    } finally {
      projectKeysByOrigin.delete(origin);
      await closeTestServer(server);
    }
  } finally {
    liveStorage?.close();
    if (!prevTranscriptDir) {
      delete process.env.SHIFT_TRANSCRIPT_DIR;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test("availability refresh preserves seats and never creates business runs", async () => {
  let available = false;
  let probes = 0;
  await withServer(
    {
      availabilityProbe: async () => {
        probes += 1;
        return {
          status: available ? "available" : "unavailable",
          reason: available ? null : "地区限制",
        };
      },
    },
    async (baseUrl) => {
      const created = await createProjectSession(baseUrl).then((res) => res.json());
      const sessionId = created.session.id;
      const getSeats = () =>
        fetch(`${baseUrl}/api/sessions/${sessionId}/collaboration`).then((res) => res.json());
      const before = await getSeats();
      assert.equal(before.seats.length, 5);
      const unavailable = await fetch(`${baseUrl}/api/agents`).then((res) => res.json());
      assert.equal(
        unavailable.agents.every((agent) => agent.routable === false),
        true
      );
      const rejected = await startChat(baseUrl, { sessionId, agent: "gemini", prompt: "hello" });
      assert.equal(rejected.status, 503);
      assert.equal((await rejected.json()).code, "NO_ROUTABLE_SEATS");
      available = true;
      const refreshed = await fetch(`${baseUrl}/api/agents/refresh`, {
        method: "POST",
        body: JSON.stringify({ agent: "gemini" }),
      });
      assert.equal(refreshed.status, 202);
      const current = await fetch(`${baseUrl}/api/agents`).then((res) => res.json());
      assert.equal(current.agents.find((agent) => agent.id === "gemini").routable, true);
      const noPlanner = await startChat(baseUrl, { sessionId, prompt: "hello" });
      assert.equal(noPlanner.status, 503);
      assert.equal((await noPlanner.json()).code, "NO_PLANNING_SEAT");
      assert.deepEqual((await getSeats()).seats, before.seats);
      const restored = await fetch(`${baseUrl}/api/sessions/${sessionId}`).then((res) =>
        res.json()
      );
      assert.equal(restored.session.messages.length, 0);
      assert.equal(probes, 6);
    }
  );
});

test("serves fixed agent list", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agents`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(
      body.agents.map((agent) => agent.id),
      ["codex", "gemini", "grok", "opencode", "claude"]
    );
    // Every agent must surface a non-empty description so the UI can show it.
    for (const agent of body.agents) {
      assert.ok(
        agent.description && agent.description.length > 0,
        `Agent ${agent.id} missing description`
      );
      // Identity metadata describes only the provider runtime. Duty is invocation-scoped.
      assert.equal(agent.role, "provider");
      assert.deepEqual(agent.duties, []);
      assert.ok(Array.isArray(agent.boundaries), `Agent ${agent.id} missing boundaries array`);
      assert.equal("workflowRole" in agent, false);
      assert.equal("workflowCapabilities" in agent, false);
      assert.equal("workflowResponsibilities" in agent, false);
    }
  });
});

test("GET /api/agents reflects SHIFT_HOME model bindings", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "shift-agent-bind-home-"));
  const runtimePaths = createRuntimePaths({ env: { SHIFT_HOME: home } });
  fs.mkdirSync(runtimePaths.dataDir, { recursive: true });
  fs.writeFileSync(
    runtimePaths.agentsConfigFile,
    `${JSON.stringify({
      agents: { gemini: { model: "gemini-3.7-flash", reasoningEffort: "medium" } },
    })}\n`
  );
  try {
    await withServer({ runtimePaths }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/agents`);
      const body = await response.json();
      const gemini = body.agents.find((agent) => agent.id === "gemini");
      assert.equal(gemini.model, "gemini-3.7-flash");
      assert.equal(gemini.reasoningEffort, "medium");
    });
  } finally {
    resetAgentCatalog();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("server startup rejects retired online storage modes", () => {
  assert.throws(() => createServer({ storageMode: "files" }), /only accepts sqlite/);
  assert.throws(() => createServer({ storageMode: "dual" }), /only accepts sqlite/);
});

test("serves React at the root without a legacy UI fallback", async () => {
  const webDistDir = fs.mkdtempSync(path.join(os.tmpdir(), "shift-web-test-"));
  const webIndexPath = path.join(webDistDir, "index.html");
  fs.mkdirSync(path.join(webDistDir, "assets"));
  fs.writeFileSync(
    webIndexPath,
    [
      '<meta name="shift-ui-token" content="__SHIFT_UI_TOKEN__" />',
      '<script type="module" src="/assets/app.js"></script>',
    ].join("\n")
  );
  fs.writeFileSync(path.join(webDistDir, "assets", "app.js"), "export {};\n");

  try {
    await withServer({ webDistDir, webIndexPath }, async (baseUrl) => {
      const response = await nativeFetch(`${baseUrl}/`);
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.match(html, new RegExp(`name="shift-ui-token" content="${TEST_UI_TOKEN}"`));
      assert.doesNotMatch(html, /__SHIFT_UI_TOKEN__/);
      assert.match(html, /src="\/assets\/app\.js"/);

      const assetResponse = await nativeFetch(`${baseUrl}/assets/app.js`);
      assert.equal(assetResponse.status, 200);
      assert.match(assetResponse.headers.get("content-type"), /javascript/);

      const legacyResponse = await nativeFetch(`${baseUrl}/legacy/`);
      assert.equal(legacyResponse.status, 404);
    });
  } finally {
    fs.rmSync(webDistDir, { recursive: true, force: true });
  }
});

test("UI API rejects requests without the per-process token", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await nativeFetch(`${baseUrl}/api/agents`);
    assert.equal(response.status, 401);
    assert.match((await response.json()).error, /UI token/i);
  });
});

test("UI API rejects cross-origin requests even with a valid token", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await nativeFetch(`${baseUrl}/api/agents`, {
      headers: {
        Origin: "https://evil.example",
        "X-Shift-UI-Token": TEST_UI_TOKEN,
      },
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /Origin/i);
  });
});

test("UI API rejects non-JSON mutation requests before spawning an agent", async () => {
  let spawnCount = 0;
  await withServer(
    {
      spawnRunner() {
        spawnCount += 1;
        return createMockChild();
      },
    },
    async (baseUrl) => {
      const created = await createProjectSession(baseUrl).then((response) => response.json());
      const response = await nativeFetch(`${baseUrl}/api/sessions/${created.session.id}/runs`, {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "X-Shift-UI-Token": TEST_UI_TOKEN,
        },
        body: JSON.stringify({ agent: "codex", prompt: "probe" }),
      });
      assert.equal(response.status, 415);
      assert.equal(spawnCount, 0);
    }
  );
});

test("chat rejects unsafe and unknown client-supplied session IDs", async () => {
  let spawnCount = 0;
  await withServer(
    {
      spawnRunner() {
        spawnCount += 1;
        return createMockChild();
      },
    },
    async (baseUrl) => {
      const unsafe = await startChat(baseUrl, { agent: "codex", prompt: "probe", sessionId: ".." });
      assert.ok([400, 404].includes(unsafe.status));

      const unknown = await startChat(baseUrl, {
        agent: "codex",
        prompt: "probe",
        sessionId: "unknown-session",
      });
      assert.equal(unknown.status, 404);
      assert.equal(spawnCount, 0);
    }
  );
});

test("chat endpoint streams assistant chunks and persists to session", async () => {
  const calls = [];
  let capturedSessionId = null;

  await withServer(
    {
      spawnRunner(command, args) {
        calls.push({ command, args });
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write(
            JSON.stringify({
              type: "text.delta",
              agent: "codex",
              invocationId: "inv-test",
              text: "partial ",
            }) + "\n"
          );
          child.stdout.write(
            JSON.stringify({
              type: "text.delta",
              agent: "codex",
              invocationId: "inv-test",
              text: "answer",
            }) + "\n"
          );
          child.stdout.write(
            JSON.stringify({
              type: "usage.update",
              agent: "codex",
              invocationId: "inv-test",
              provider: "codex",
              scope: "step",
              mode: "delta",
              inputTokens: 100,
              outputTokens: 20,
              totalTokens: 120,
            }) + "\n"
          );
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const response = await chatInNewProjectSession(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "codex", prompt: "hello" }),
      });
      const text = await response.text();

      assert.equal(response.status, 200);
      assert.equal(
        calls[0].args[0],
        path.resolve(__dirname, "..", "src", "agents", "invoke-cli.js")
      );
      assert.equal(calls[0].args[1], "--agent");
      assert.equal(calls[0].args[2], "codex");
      assert.ok(
        calls[0].args[3].includes("hello"),
        `Expected prompt to contain "hello", got: ${calls[0].args[3]?.slice(-50)}`
      );
      assert.ok(
        calls[0].args[3].includes("委托准备主 Agent"),
        "Expected preparation prompt to contain the delegation contract instructions"
      );
      assert.ok(
        calls[0].args[3].includes("MCP 回调工具说明"),
        "Expected prompt to contain callback instructions"
      );
      // Soft collab rules must be present on the first (non-A2A) turn.
      assert.match(calls[0].args[3], /delegation_plan/);
      assert.match(calls[0].args[3], /禁止 handoff/);
      assert.match(calls[0].args[3], /只分析用户目标/);
      assert.match(text, /"type":"text.delta"/);
      assert.match(text, /"text":"partial answer"/);
      const sessionMatch = text.match(/"sessionId":"([^"]+)"/);
      assert.ok(sessionMatch, "Expected snapshot/session id");
      capturedSessionId = sessionMatch[1];

      // Verify messages can be retrieved via /api/messages?sessionId=
      const historyResponse = await fetch(`${baseUrl}/api/messages?sessionId=${capturedSessionId}`);
      const history = await historyResponse.json();
      assert.equal(history.messages.length, 2);
      assert.equal(history.messages[0].role, "user");
      assert.equal(history.messages[0].agent, "codex");
      assert.equal(history.messages[1].role, "assistant");
      assert.equal(history.messages[1].content, "partial answer");
      assert.equal(history.messages[1].usage.totalTokens, 120);
      assert.match(text, /event: agent-exit\ndata: .*"usage":\{.*"totalTokens":120/);
    }
  );
});

test("chat endpoint defaults to codex when agent field is omitted", async () => {
  const calls = [];

  await withServer(
    {
      spawnRunner(_command, args) {
        calls.push(args);
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write(
            JSON.stringify({
              type: "text.delta",
              agent: "codex",
              invocationId: "inv-default",
              text: "ok",
            }) + "\n"
          );
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const response = await chatInNewProjectSession(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "hello without agent" }),
      });
      assert.equal(response.status, 200);
      assert.ok(calls.length >= 1, "expected spawn");
      assert.equal(calls[0][1], "--agent");
      assert.equal(calls[0][2], "codex");
      await response.text();
    }
  );
});

test("chat endpoint emits canonical agent-event SSE frames", async () => {
  await withServer(
    {
      spawnRunner() {
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write(
            JSON.stringify({
              type: "run.started",
              agent: "opencode",
              invocationId: "inv-1",
              provider: "opencode",
            }) + "\n"
          );
          child.stdout.write(
            JSON.stringify({
              type: "text.delta",
              agent: "opencode",
              invocationId: "inv-1",
              text: "hello ",
            }) + "\n"
          );
          child.stdout.write(
            JSON.stringify({
              type: "progress.update",
              agent: "opencode",
              invocationId: "inv-1",
              items: [{ text: "done", done: true }],
            }) + "\n"
          );
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const response = await chatInNewProjectSession(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "opencode", prompt: "hello" }),
      });
      const text = await response.text();
      assert.match(text, /event: agent-event/);
      assert.match(text, /"type":"text.delta"/);
      assert.match(text, /"type":"progress.update"/);
    }
  );
});

test("chat history excludes commentary and stores only final text.delta", async () => {
  await withServer(
    {
      spawnRunner() {
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write(
            JSON.stringify({
              type: "run.started",
              agent: "opencode",
              invocationId: "inv-2",
              provider: "opencode",
            }) + "\n"
          );
          child.stdout.write(
            JSON.stringify({
              type: "thinking.delta",
              agent: "opencode",
              invocationId: "inv-2",
              text: "inspect",
            }) + "\n"
          );
          child.stdout.write(
            JSON.stringify({
              type: "commentary.delta",
              agent: "opencode",
              invocationId: "inv-2",
              text: "working update",
            }) + "\n"
          );
          child.stdout.write(
            JSON.stringify({
              type: "text.delta",
              agent: "opencode",
              invocationId: "inv-2",
              text: "final answer",
            }) + "\n"
          );
          child.stdout.write(
            JSON.stringify({
              type: "run.finished",
              agent: "opencode",
              invocationId: "inv-2",
              exitCode: 0,
              signal: null,
            }) + "\n"
          );
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const response = await chatInNewProjectSession(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "opencode", prompt: "hello" }),
      });
      const sse = await response.text();
      const sid = sse.match(/"sessionId":"([^"]+)"/)[1];
      const history = await (await fetch(`${baseUrl}/api/messages?sessionId=${sid}`)).json();
      const assistant = history.messages.find((msg) => msg.role === "assistant");
      assert.equal(assistant.content, "final answer");
      assert.doesNotMatch(assistant.content, /working update/);
    }
  );
});

test("chat endpoint preserves raw stdout chunk boundaries in SSE message events", async () => {
  await withServer(
    {
      spawnRunner() {
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write(
            JSON.stringify({
              type: "text.delta",
              agent: "opencode",
              invocationId: "inv-chunks",
              text: "line 1\n\n",
            }) + "\n"
          );
          child.stdout.write(
            JSON.stringify({
              type: "text.delta",
              agent: "opencode",
              invocationId: "inv-chunks",
              text: "    code-ish indent\n",
            }) + "\n"
          );
          child.stdout.write(
            JSON.stringify({
              type: "text.delta",
              agent: "opencode",
              invocationId: "inv-chunks",
              text: "- list item",
            }) + "\n"
          );
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const response = await chatInNewProjectSession(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "opencode", prompt: "hello chunks" }),
      });
      const text = await response.text();

      assert.match(text, /"type":"text.delta"/);
      assert.match(text, /line 1/);
      assert.match(text, /code-ish indent/);
      assert.match(text, /list item/);
    }
  );
});

test("chat endpoint rejects all agent mode", async () => {
  await withServer(
    {
      spawnRunner() {
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write("should not run");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const created = await createProjectSession(baseUrl).then((res) => res.json());
      const response = await startChat(baseUrl, {
        sessionId: created.session.id,
        agent: "all",
        prompt: "compare",
      });
      const body = await response.json();

      assert.equal(response.status, 400);
      assert.match(body.error, /Unsupported agent/);
    }
  );
});

test("chat endpoint suppresses benign codex startup stderr", async () => {
  await withServer(
    {
      spawnRunner() {
        const child = createMockChild();
        process.nextTick(() => {
          child.stderr.write("Reading additional input from stdin...\n");
          child.stderr.write(
            "2026-06-28T13:52:47.421934Z WARN codex_core_plugins::manifest: ignoring interface.defaultPrompt: maximum of 3 prompts is supported\n"
          );
          child.stdout.write(
            JSON.stringify({
              type: "text.delta",
              agent: "codex",
              invocationId: "inv-answer",
              text: "answer",
            }) + "\n"
          );
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const response = await chatInNewProjectSession(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "codex", prompt: "@Codex hello" }),
      });
      const text = await response.text();

      assert.equal(response.status, 200);
      assert.match(text, /"text":"answer"/);
      assert.doesNotMatch(text, /Reading additional input/);
      assert.doesNotMatch(text, /codex_core_plugins::manifest/);
      assert.doesNotMatch(text, /event: stderr/);
    }
  );
});

test("messages endpoint requires an explicit Session scope", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/messages`);
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.error, /sessionId is required/);
  });
});

// ── Session CRUD tests ─────────────────────────────────────────

test("POST /api/sessions creates a Project-bound session", async () => {
  await withServer({}, async (baseUrl, { projectKey }) => {
    const response = await createProjectSession(baseUrl);
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.ok(body.session.id, "session should have an id");
    assert.equal(body.session.title, "");
    assert.deepEqual(body.session.messages, []);
    assert.equal(body.session.messageCount, 0);
    assert.equal(body.session.projectKey, projectKey);
    assert.ok(body.session.projectDir);
  });
});

test("GET /api/projects/:projectKey/sessions lists only that Project's Sessions", async () => {
  await withServer({}, async (baseUrl, { projectKey }) => {
    // Create two sessions
    await createProjectSession(baseUrl);
    await createProjectSession(baseUrl);

    const response = await fetch(
      `${baseUrl}/api/projects/${encodeURIComponent(projectKey)}/sessions`
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.sessions.length, 2);
    assert.ok(body.sessions[0].createdAt >= body.sessions[1].createdAt, "sorted newest first");
  });
});

test("GET /api/sessions/:id returns a specific session", async () => {
  await withServer({}, async (baseUrl) => {
    const created = await createProjectSession(baseUrl);
    const { session } = await created.json();

    const response = await fetch(`${baseUrl}/api/sessions/${session.id}`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.session.id, session.id);
    assert.deepEqual(body.session.messages, []);
  });
});

test("GET /api/sessions/:id returns 404 for unknown session", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sessions/nonexistent`);
    assert.equal(response.status, 404);
  });
});

test("DELETE /api/sessions/:id deletes a session", async () => {
  await withServer({}, async (baseUrl) => {
    const created = await createProjectSession(baseUrl);
    const { session } = await created.json();

    const response = await fetch(`${baseUrl}/api/sessions/${session.id}`, { method: "DELETE" });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);

    // Verify it's gone
    const getResponse = await fetch(`${baseUrl}/api/sessions/${session.id}`);
    assert.equal(getResponse.status, 404);
  });
});

test("DELETE /api/sessions/:id returns 404 for unknown session", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sessions/nonexistent`, { method: "DELETE" });
    assert.equal(response.status, 404);
  });
});

test("DELETE /api/sessions/:id does not let a still-running chat recreate the session", async () => {
  const spawned = [];

  await withServer(
    {
      spawnRunner() {
        const child = createMockChild();
        child.closeNow = (code = 0, signal = null) => child.emit("close", code, signal);
        spawned.push(child);
        return child;
      },
    },
    async (baseUrl) => {
      const created = await createProjectSession(baseUrl);
      const { session } = await created.json();

      const chatPromise = startChat(baseUrl, {
        agent: "codex",
        prompt: "long task",
        sessionId: session.id,
      }).then((res) => res.text());

      const deadline = Date.now() + 2000;
      while (spawned.length < 1 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(spawned.length, 1);

      const deleted = await fetch(`${baseUrl}/api/sessions/${session.id}`, { method: "DELETE" });
      assert.equal(deleted.status, 200);

      spawned[0].stdout.write("late answer");
      spawned[0].closeNow(0, null);
      await chatPromise;

      const getResponse = await fetch(`${baseUrl}/api/sessions/${session.id}`);
      assert.equal(getResponse.status, 404);
    }
  );
});

test("session run stores messages on the bound session", async () => {
  await withServer(
    {
      spawnRunner(_command, _args) {
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write("ok");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      // Create session first
      const created = await createProjectSession(baseUrl);
      const { session } = await created.json();

      // Chat into that session (consume body to wait for stream completion)
      const chatResp = await startChat(baseUrl, {
        agent: "codex",
        prompt: "hello",
        sessionId: session.id,
      });
      await chatResp.text(); // drain SSE stream — ensures appendToSession ran

      // Verify messages are there
      const got = await fetch(`${baseUrl}/api/sessions/${session.id}`);
      const body = await got.json();
      assert.equal(body.session.messages.length, 2, "should have user + assistant messages");
      assert.equal(body.session.title, "hello", "title should summarize the first user message");
    }
  );
});

test("session run reuses a user message for the same clientTurnId", async () => {
  await withServer(
    {
      spawnRunner() {
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write("ok");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const created = await createProjectSession(baseUrl);
      const { session } = await created.json();

      async function sendTurn(clientTurnId) {
        const response = await startChat(baseUrl, {
          agent: "codex",
          prompt: "repeat exactly",
          sessionId: session.id,
          clientTurnId,
        });
        assert.ok([200, 202].includes(response.status));
        return response.text();
      }

      const first = await sendTurn("turn-same");
      const retry = await sendTurn("turn-same");
      const firstTrigger = [...first.matchAll(/"triggerMessageId":"([^"]+)"/g)].at(-1)?.[1];
      const retryTrigger = [...retry.matchAll(/"triggerMessageId":"([^"]+)"/g)].at(-1)?.[1];
      const firstInvocation = [
        ...first.matchAll(/event: agent-start\ndata: \{"agent":"codex","invocationId":"([^"]+)"/g),
      ].at(-1)?.[1];
      const retryInvocation = [
        ...retry.matchAll(/event: agent-start\ndata: \{"agent":"codex","invocationId":"([^"]+)"/g),
      ].at(-1)?.[1];
      assert.ok(firstTrigger);
      assert.equal(retryTrigger, firstTrigger);
      assert.ok(firstInvocation);
      assert.ok(retryInvocation);
      assert.equal(retryInvocation, firstInvocation);

      let detail = await fetch(`${baseUrl}/api/sessions/${session.id}`).then((response) =>
        response.json()
      );
      assert.equal(detail.session.messages.filter((message) => message.role === "user").length, 1);
      assert.equal(detail.session.messages[0].clientTurnId, "turn-same");

      await sendTurn("turn-intentional-repeat");
      detail = await fetch(`${baseUrl}/api/sessions/${session.id}`).then((response) =>
        response.json()
      );
      assert.equal(detail.session.messages.filter((message) => message.role === "user").length, 2);
    }
  );
});

test("session run rejects the retired projectDir override", async () => {
  await withServer(
    {
      spawnRunner() {
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write("should not run");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const created = await createProjectSession(baseUrl).then((response) => response.json());
      const response = await nativeFetch(`${baseUrl}/api/sessions/${created.session.id}/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Shift-UI-Token": TEST_UI_TOKEN,
        },
        body: JSON.stringify({
          agent: "codex",
          prompt: "hello",
          sessionId: created.session.id,
          projectDir: path.join(os.tmpdir(), "definitely-missing-project-dir"),
        }),
      });
      const text = await response.text();

      assert.equal(response.status, 400);
      const body = JSON.parse(text);
      assert.match(body.error, /cannot be changed/);
    }
  );
});

test("chat preserves the Project binding assigned when the Session was created", async () => {
  await withServer(
    {
      initialSessionIds: ["legacy-empty-session"],
      spawnRunner() {
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write("bound");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const before = await fetch(`${baseUrl}/api/sessions/legacy-empty-session`).then((response) =>
        response.json()
      );
      const originalProjectKey = before.session.projectKey;
      assert.ok(before.session.projectDir);

      const response = await startChat(baseUrl, {
        sessionId: "legacy-empty-session",
        agent: "codex",
        prompt: "bind project first",
        clientTurnId: "legacy-bind-turn",
      });
      assert.equal(response.status, 200);
      await response.text();

      const after = await fetch(`${baseUrl}/api/sessions/legacy-empty-session`).then((result) =>
        result.json()
      );
      assert.equal(after.session.projectKey, originalProjectKey);
    }
  );
});

test("Project opening creates Sessions whose execution directories cannot drift", async () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "server-project-a-"));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "server-project-b-"));
  const cwds = [];

  await withServer(
    {
      spawnRunner(command, args, options) {
        cwds.push(options.cwd);
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write("ok");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const projectA = await fetch(`${baseUrl}/api/projects/open`, {
        method: "POST",
        body: JSON.stringify({ dir: dirA }),
      }).then((response) => response.json());
      const projectB = await fetch(`${baseUrl}/api/projects/open`, {
        method: "POST",
        body: JSON.stringify({ dir: dirB }),
      }).then((response) => response.json());
      const sessionA = await nativeFetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Shift-UI-Token": TEST_UI_TOKEN,
        },
        body: JSON.stringify({ projectKey: projectA.project.projectKey }),
      }).then((response) => response.json());
      const sessionB = await nativeFetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Shift-UI-Token": TEST_UI_TOKEN,
        },
        body: JSON.stringify({ projectKey: projectB.project.projectKey }),
      }).then((response) => response.json());

      let response = await startChat(baseUrl, {
        agent: "opencode",
        prompt: "hello A",
        sessionId: sessionA.session.id,
      });
      assert.equal(response.status, 200);
      await response.text();

      response = await startChat(baseUrl, {
        agent: "opencode",
        prompt: "hello B",
        sessionId: sessionB.session.id,
      });
      assert.equal(response.status, 200);
      await response.text();

      assert.deepEqual(cwds, [projectA.project.canonicalPath, projectB.project.canonicalPath]);
    }
  );
});

test("chat endpoint does not create a worktree by default", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-no-worktree-base-"));
  const calls = [];

  await withServer(
    {
      worktreeManager: {
        ensureWorktree() {
          throw new Error("ensureWorktree should not be called for default chat runs");
        },
      },
      spawnRunner(command, args, options) {
        calls.push({ command, args, cwd: options.cwd, env: options.env });
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write("answer");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const { session } = await openProjectSession(baseUrl, baseDir).then((result) =>
        result.json()
      );
      const response = await startChat(baseUrl, {
        agent: "opencode",
        prompt: "@Gemini hello",
        sessionId: session.id,
      });
      await response.text();

      assert.equal(response.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].cwd, normalizeCanonicalPath(baseDir));
      assert.equal(calls[0].env.SHIFT_WORKTREE, "0");
      assert.equal(calls[0].env.SHIFT_BASE_DIR, normalizeCanonicalPath(baseDir));
      assert.equal(calls[0].env.SHIFT_WORKTREE_DIR, normalizeCanonicalPath(baseDir));
      assert.equal(calls[0].env.SHIFT_BRANCH, "");
    }
  );
});

test("worktree status, diff, and discard endpoints delegate to manager", async () => {
  const calls = [];
  await withServer(
    {
      worktreeManager: {
        getStatus(sessionId) {
          calls.push(["status", sessionId]);
          return {
            sessionId,
            branch: "codex/session-x",
            clean: false,
            porcelain: [" M server.js"],
          };
        },
        getDiff(sessionId) {
          calls.push(["diff", sessionId]);
          return "diff --git a/server.js b/server.js\n";
        },
        discardWorktree(sessionId) {
          calls.push(["discard", sessionId]);
          return { ok: true, sessionId };
        },
      },
    },
    async (baseUrl) => {
      const created = await createProjectSession(baseUrl);
      const { session } = await created.json();

      const statusResponse = await fetch(`${baseUrl}/api/sessions/${session.id}/worktree/status`);
      assert.equal(statusResponse.status, 200);
      assert.equal((await statusResponse.json()).clean, false);

      const diffResponse = await fetch(`${baseUrl}/api/sessions/${session.id}/worktree/diff`);
      assert.equal(diffResponse.status, 200);
      assert.match((await diffResponse.json()).diff, /diff --git/);

      const discardResponse = await fetch(
        `${baseUrl}/api/sessions/${session.id}/worktree/discard`,
        { method: "POST" }
      );
      assert.equal(discardResponse.status, 200);
      assert.equal((await discardResponse.json()).ok, true);

      assert.deepEqual(calls, [
        ["status", session.id],
        ["diff", session.id],
        ["discard", session.id],
      ]);
    }
  );
});

test("worktree diff endpoint truncates oversized payloads", async () => {
  const hugeDiff = `diff --git a/a.txt b/a.txt\n${"+x\n".repeat(90000)}`;

  await withServer(
    {
      worktreeManager: {
        getStatus(sessionId) {
          return { sessionId, branch: "codex/session-x", clean: false, porcelain: [" M a.txt"] };
        },
        getDiff() {
          return hugeDiff;
        },
        discardWorktree(sessionId) {
          return { ok: true, sessionId };
        },
      },
    },
    async (baseUrl) => {
      const created = await createProjectSession(baseUrl);
      const { session } = await created.json();

      const diffResponse = await fetch(`${baseUrl}/api/sessions/${session.id}/worktree/diff`);
      const body = await diffResponse.json();

      assert.equal(diffResponse.status, 200);
      assert.equal(body.truncated, true);
      assert.equal(body.totalChars, hugeDiff.length);
      assert.ok(body.diff.length < hugeDiff.length);
      assert.match(body.diff, /\[workspace diff truncated/i);
    }
  );
});

// ── A2A routing unit tests ────────────────────────────────────

test("parseA2AMentions routes @label and @id consistently", () => {
  assert.deepEqual(parseA2AMentions("@Codex 帮我 review", "opencode"), ["codex"]);
  assert.deepEqual(parseA2AMentions("@codex 帮我 review", "opencode"), ["codex"]);
  assert.deepEqual(parseA2AMentions("@Gemini 继续实现", "codex"), ["gemini"]);
  assert.deepEqual(parseA2AMentions("@gemini 继续实现", "codex"), ["gemini"]);
});

test("parseA2AMentions filters self and code blocks", () => {
  assert.deepEqual(parseA2AMentions("@gemini 帮我", "gemini"), []);
  assert.deepEqual(parseA2AMentions("```\n@gemini 帮我\n```\n@OpenCode 看下", "codex"), [
    "opencode",
  ]);
});

test("parseA2AMentions caps at 2 targets", () => {
  const text = "@Gemini 方案\n@Grok 实现\n@OpenCode review";
  const mentions = parseA2AMentions(text, "codex");
  assert.equal(mentions.length, 2);
});

test("parseA2AMentions rejects removed agent names", () => {
  const text = "@architect 方案\n@万事通 测试\n@小码 实现\n@小评 review";
  assert.deepEqual(parseA2AMentions(text, "codex"), []);
});

// ── MCP callback tests ────────────────────────────────────────

test("callback post-message rejects invalid token", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/callbacks/post-message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-1",
        invocationId: "invocation-1",
        callbackToken: "invalid",
        content: "hello",
      }),
    });
    assert.equal(response.status, 401);
  });
});

test("callbacks.postMessage persists, broadcasts, and enqueues A2A targets", () => {
  const sseEvents = [];
  const fakeRes = {
    destroyed: false,
    writableEnded: false,
    write(chunk) {
      sseEvents.push(chunk);
      return true;
    },
  };

  const sessionId = "session-cb-1";
  const worklist = ["codex"];
  const controller = new AbortController();
  const threadCtx = {
    res: fakeRes,
    worklist,
    controller,
    a2aCount: 0,
    tokens: new Map(),
    ...callbackSeatRouting(sessionId),
  };

  const invocationId = "invocation-cb-1";
  const callbackToken = "token-cb-1";
  threadCtx.tokens.set(invocationId, { agentId: "codex", callbackToken });
  callbacks.registerThread(sessionId, threadCtx);

  const appended = [];
  const appendFn = (sid, msg) => appended.push({ sid, msg });
  const acceptedFlights = new Map();
  const durableRecorder = {
    markHandoffEnqueued(handoffId) {
      return { handoffId, enqueuedAt: new Date().toISOString() };
    },
    acceptHandoff(input) {
      const key = `${input.sourceInvocationId}:${input.targetAgentId}`;
      const prior = acceptedFlights.get(key);
      if (prior) {
        return {
          accepted: false,
          status: "duplicate",
          record: { ...prior, duplicateOf: prior.handoffId },
        };
      }
      const record = {
        handoffId: "h-callback-1",
        routeStatus: "accepted",
        completeStatus: "pending",
        depth: input.depth,
      };
      acceptedFlights.set(key, record);
      return { accepted: true, status: "accepted", record };
    },
  };

  const ok = callbacks.postMessage(sessionId, invocationId, "@Gemini 请继续实现", {
    appendToSession: appendFn,
    durableRecorder,
  });

  assert.equal(ok.ok, true);
  assert.equal(ok.messagePosted, true);
  assert.equal(ok.handoff.status, "accepted");
  assert.deepEqual(ok.handoff.queuedAgents, ["gemini"]);
  assert.equal(appended.length, 2);
  assert.equal(appended[0].msg.role, "assistant");
  assert.equal(appended[0].msg.agent, "codex");
  assert.equal(appended[0].msg.content, "@Gemini 请继续实现");
  assert.equal(appended[1].msg.role, "system");
  assert.equal(appended[1].msg.kind, "a2a-route");
  assert.equal(appended[1].msg.from, "codex");
  assert.equal(appended[1].msg.to, "gemini");
  // Route text uses agent labels; payload still uses agent ids.
  assert.match(appended[1].msg.content, /Codex.*Gemini|codex.*gemini/i);
  assert.equal(appended[1].msg.handoffPolicy, "allow_degraded");
  assert.equal(worklist.includes("gemini"), true);
  assert.equal(threadCtx.a2aCount, 1);
  assert.deepEqual(worklist, ["codex", "gemini"]);

  const joined = sseEvents.join("");
  assert.match(
    joined,
    /event: message\ndata: \{"agent":"codex","role":"assistant","text":"@Gemini 请继续实现"\}/
  );
  assert.match(joined, /event: a2a-route\ndata: \{"from":"codex","to":"gemini"/);

  // Idempotency: the same source invocation cannot route to the same target twice.
  const ok2 = callbacks.postMessage(sessionId, invocationId, "@Gemini 请按补充意见继续", {
    appendToSession: appendFn,
    durableRecorder,
  });
  assert.equal(ok2.handoff.status, "skipped");
  assert.deepEqual(worklist, ["codex", "gemini"]);
  assert.equal(threadCtx.a2aCount, 1);

  callbacks.unregisterThread(sessionId);
});

for (const provider of ["codex", "gemini", "grok", "opencode", "claude"]) {
  test(`${provider} callback persists a concrete plan regardless of permission capability`, () => {
    const sessionId = `session-cb-${provider}-plan`;
    const invocationId = `invocation-cb-${provider}-plan`;
    const sse = [];
    const registry = createCollabTaskRegistry();
    registry.ensureImplementationPlanRequired(sessionId, { requestedBy: "codex" });
    const threadCtx = {
      res: {
        destroyed: false,
        writableEnded: false,
        write(chunk) {
          sse.push(chunk);
          return true;
        },
      },
      worklist: [provider],
      controller: new AbortController(),
      a2aCount: 0,
      useWorktree: true,
      collabTaskRegistry: registry,
      currentDutyBinding: {
        seatId: `seat-${sessionId}-${provider}`,
        duty: "plan",
        skillName: "implementation-plan",
        routingReason: "sticky",
        enforcementLevel: provider === "grok" ? "enforced" : "advisory",
      },
      tokens: new Map([[invocationId, { agentId: provider, callbackToken: "token" }]]),
      ...callbackSeatRouting(sessionId),
    };
    callbacks.registerThread(sessionId, threadCtx);

    try {
      const content = [
        "```implementation_plan",
        "summary: Implement the callback change",
        "files:",
        "  - src/callback-change.js",
        "changes:",
        "  - Add the requested callback behavior",
        "tests:",
        "  - node --test tests/callback-change.test.js",
        "```",
      ].join("\n");
      const result = callbacks.postMessage(sessionId, invocationId, content);

      assert.equal(result.ok, true);
      assert.equal(registry.getTask(sessionId).implementationGate.status, "pending_approval");
      assert.match(registry.getTask(sessionId).implementationGate.planHash, /^[a-f0-9]{16}$/);
      assert.match(sse.join(""), /event: implementation-plan-submitted/);
    } finally {
      callbacks.unregisterThread(sessionId);
    }
  });
}

test("callbacks.postMessage captures structured handoff only for an enqueued target", () => {
  const sessionId = "session-cb-memory";
  const invocationId = "invocation-cb-memory";
  const captured = [];
  const sse = [];
  const threadCtx = {
    res: {
      destroyed: false,
      writableEnded: false,
      write(chunk) {
        sse.push(chunk);
        return true;
      },
    },
    worklist: ["codex"],
    controller: new AbortController(),
    a2aCount: 0,
    windowId: "window-cb-1",
    tokens: new Map([[invocationId, { agentId: "codex", callbackToken: "token" }]]),
    ...callbackSeatRouting(sessionId),
  };
  callbacks.registerThread(sessionId, threadCtx);

  try {
    const content = [
      "@Gemini 请继续实现",
      "```handoff",
      "to: gemini",
      "goal: 完成登录流程",
      "what: 接口设计已完成",
      "why: 保持兼容",
      "next_action: 实现并测试",
      "```",
    ].join("\n");
    const ok = callbacks.postMessage(sessionId, invocationId, content, {
      durableRecorder: {
        acceptHandoff: (input) => ({
          accepted: true,
          status: "accepted",
          record: {
            handoffId: "h-callback-memory",
            routeStatus: "accepted",
            completeStatus: "pending",
            depth: input.depth,
          },
        }),
        markHandoffEnqueued: (handoffId) => ({ handoffId, enqueuedAt: new Date().toISOString() }),
      },
      memoryCapture: {
        captureHandoff(input) {
          captured.push(input);
          return { captured: true, event: { captureKey: "handoff-key" } };
        },
      },
    });

    assert.equal(ok.handoff.status, "accepted");
    assert.equal(captured.length, 1);
    assert.equal(captured[0].fromAgent, "codex");
    assert.equal(captured[0].toAgent, "gemini");
    assert.equal(captured[0].blockIndex, 0);
    assert.equal(captured[0].windowId, "window-cb-1");
    assert.equal(captured[0].quality.ok, true);
    assert.equal(captured[0].handoff.goal, "完成登录流程");
    assert.match(sse.join(""), /event: handoff-captured/);
  } finally {
    callbacks.unregisterThread(sessionId);
  }
});

function callbackSeatRouting(threadId) {
  const seats = Object.entries(AGENTS).map(([providerId, profile]) => ({
    seatId: `seat-${threadId}-${providerId}`,
    threadId,
    providerId,
    label: profile.label,
    enabled: true,
  }));
  return {
    agents: AGENTS,
    threadSeats: { listEnabledForThread: () => seats },
  };
}

test("callbacks.postMessage captures handoff even when A2A max depth skips enqueue", () => {
  const sessionId = "session-cb-memory-depth";
  const invocationId = "invocation-cb-memory-depth";
  const previousDepth = process.env.MAX_A2A_DEPTH;
  process.env.MAX_A2A_DEPTH = "1";
  const captured = [];
  const sse = [];
  const threadCtx = {
    res: {
      destroyed: false,
      writableEnded: false,
      write(chunk) {
        sse.push(chunk);
        return true;
      },
    },
    worklist: ["codex"],
    controller: new AbortController(),
    a2aCount: 1,
    windowId: "window-depth-1",
    tokens: new Map([[invocationId, { agentId: "codex", callbackToken: "token" }]]),
    ...callbackSeatRouting(sessionId),
  };
  callbacks.registerThread(sessionId, threadCtx);

  try {
    const content = [
      "@Gemini 请继续实现",
      "```handoff",
      "to: gemini",
      "goal: 完成登录流程",
      "what: 接口设计已完成",
      "why: 保持兼容",
      "next_action: 实现并测试",
      "```",
    ].join("\n");
    const ok = callbacks.postMessage(sessionId, invocationId, content, {
      memoryCapture: {
        captureHandoff(input) {
          captured.push(input);
          return { captured: true, event: { captureKey: "handoff-depth" } };
        },
      },
    });

    assert.equal(ok.handoff.status, "skipped");
    assert.equal(ok.handoff.accepted, false);
    assert.deepEqual(ok.handoff.skippedAgents, ["gemini"]);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].toAgent, "gemini");
    assert.equal(captured[0].windowId, "window-depth-1");
    assert.deepEqual(threadCtx.worklist, ["codex"]);
    assert.equal(threadCtx.a2aCount, 1);
    assert.match(sse.join(""), /event: handoff-captured/);
    assert.match(sse.join(""), /event: a2a-skipped/);
  } finally {
    callbacks.unregisterThread(sessionId);
    if (previousDepth === undefined) delete process.env.MAX_A2A_DEPTH;
    else process.env.MAX_A2A_DEPTH = previousDepth;
  }
});

test("callbacks.validateToken accepts only exact matches", () => {
  const sessionId = "session-vt-1";
  const invocationId = "invocation-vt-1";
  const callbackToken = "token-vt-1";
  const threadCtx = {
    tokens: new Map([
      [invocationId, { agentId: "codex", callbackToken, expiresAt: Date.now() + 60_000 }],
    ]),
  };
  callbacks.registerThread(sessionId, threadCtx);

  assert.equal(callbacks.validateToken(sessionId, invocationId, callbackToken), true);
  assert.equal(callbacks.validateToken(sessionId, invocationId, "wrong"), false);
  assert.equal(callbacks.validateToken(sessionId, "missing", callbackToken), false);
  assert.equal(callbacks.validateToken("missing", invocationId, callbackToken), false);

  callbacks.unregisterThread(sessionId);
});

// ── Thread Affinity + TTL tests (lesson 08) ───────────────────

test("createInvocation returns expiresAt and stamps expiresAt on the token", () => {
  const sessionId = "session-ttl-1";
  const threadCtx = {
    res: {
      destroyed: false,
      writableEnded: false,
      write() {
        return true;
      },
    },
    worklist: ["codex"],
    controller: new AbortController(),
    a2aCount: 0,
    tokens: new Map(),
  };
  callbacks.registerThread(sessionId, threadCtx);

  const before = Date.now();
  const { invocationId, callbackToken, expiresAt } = callbacks.createInvocation(sessionId, "codex");
  const after = Date.now();

  assert.ok(typeof invocationId === "string" && invocationId.length > 0);
  assert.ok(typeof callbackToken === "string" && callbackToken.length > 0);
  assert.ok(typeof expiresAt === "number");
  assert.ok(expiresAt >= before + 30 * 60 * 1000, "expiresAt should be ~30 min in the future");
  assert.ok(expiresAt <= after + 30 * 60 * 1000, "expiresAt should be ~30 min in the future");

  const stored = threadCtx.tokens.get(invocationId);
  assert.equal(stored.callbackToken, callbackToken);
  assert.equal(stored.expiresAt, expiresAt);

  callbacks.unregisterThread(sessionId);
});

test("createInvocation draws the callback token from an independent CSPRNG source", () => {
  const sessionId = "session-token-entropy";
  callbacks.registerThread(sessionId, { tokens: new Map(), controller: new AbortController() });
  try {
    const issued = new Set();
    for (let i = 0; i < 64; i += 1) {
      const { invocationId, callbackToken } = callbacks.createInvocation(sessionId, "codex");
      // The invocation id is published (SSE, URLs, UI); the callback token is
      // the secret that authenticates the MCP bridge. They must not share a
      // generator, and the token must be unpredictable CSPRNG output.
      assert.notEqual(invocationId, callbackToken);
      assert.ok(!invocationId.includes(callbackToken));
      assert.ok(callbackToken.length >= 32, "token carries 256 bits of entropy");
      issued.add(callbackToken);
    }
    assert.equal(issued.size, 64, "no duplicate tokens across 64 invocations");
  } finally {
    callbacks.unregisterThread(sessionId);
  }
});

test("safeEqual compares secrets in constant time and never throws", () => {
  const { safeEqual } = require("../src/shared/secret-compare");
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  // Differing lengths must not throw — timingSafeEqual would.
  assert.equal(safeEqual("a", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), false);
  assert.equal(safeEqual(null, undefined), true);
  assert.equal(safeEqual(undefined, "x"), false);
});

test("SHIFT_TOKEN_TTL_MS overrides the default TTL", () => {
  const sessionId = "session-ttl-2";
  const threadCtx = {
    res: {
      destroyed: false,
      writableEnded: false,
      write() {
        return true;
      },
    },
    worklist: ["codex"],
    controller: new AbortController(),
    a2aCount: 0,
    tokens: new Map(),
  };
  callbacks.registerThread(sessionId, threadCtx);

  const prev = process.env.SHIFT_TOKEN_TTL_MS;
  process.env.SHIFT_TOKEN_TTL_MS = "60000";
  try {
    const { expiresAt } = callbacks.createInvocation(sessionId, "codex");
    const expected = Date.now() + 60000;
    assert.ok(
      Math.abs(expiresAt - expected) < 100,
      `expiresAt should be ~60s in the future, got diff ${Math.abs(expiresAt - expected)}ms`
    );
  } finally {
    if (prev === undefined) delete process.env.SHIFT_TOKEN_TTL_MS;
    else process.env.SHIFT_TOKEN_TTL_MS = prev;
    callbacks.unregisterThread(sessionId);
  }
});

test("validateToken rejects expired tokens and lazily cleans them up", () => {
  const sessionId = "session-exp-1";
  const invocationId = "invocation-exp-1";
  const callbackToken = "token-exp-1";
  const threadCtx = {
    res: {
      destroyed: false,
      writableEnded: false,
      write() {
        return true;
      },
    },
    worklist: ["codex"],
    controller: new AbortController(),
    a2aCount: 0,
    tokens: new Map([
      [
        invocationId,
        {
          agentId: "codex",
          callbackToken,
          createdAt: Date.now() - 60_000,
          expiresAt: Date.now() - 1000, // already expired
        },
      ],
    ]),
  };
  callbacks.registerThread(sessionId, threadCtx);

  assert.equal(callbacks.validateToken(sessionId, invocationId, callbackToken), false);
  assert.equal(threadCtx.tokens.has(invocationId), false, "expired token should be cleaned up");

  callbacks.unregisterThread(sessionId);
});

test("validateToken rejects tokens without a valid expiry", () => {
  const sessionId = "session-leg-1";
  const invocationId = "invocation-leg-1";
  const callbackToken = "token-leg-1";
  const threadCtx = {
    res: {
      destroyed: false,
      writableEnded: false,
      write() {
        return true;
      },
    },
    worklist: ["codex"],
    controller: new AbortController(),
    a2aCount: 0,
    tokens: new Map([[invocationId, { agentId: "codex", callbackToken }]]), // no expiresAt
  };
  callbacks.registerThread(sessionId, threadCtx);

  assert.equal(callbacks.validateToken(sessionId, invocationId, callbackToken), false);
  assert.equal(threadCtx.tokens.has(invocationId), false, "malformed token should be cleaned up");

  callbacks.unregisterThread(sessionId);
});

test("active invocation token does not expire on wall-clock TTL and remains valid for long tasks", () => {
  const sessionId = "session-long-task";
  const invocationId = "inv-long-1";
  const callbackToken = "tok-long-1";
  const threadCtx = {
    currentInvocationId: invocationId,
    tokens: new Map([
      [
        invocationId,
        {
          agentId: "grok",
          callbackToken,
          createdAt: Date.now() - 3600_000,
          expiresAt: Date.now() - 1000, // wall-clock expired
          retired: false,
        },
      ],
    ]),
  };
  callbacks.registerThread(sessionId, threadCtx);

  // While the invocation is actively running, validateToken must succeed
  assert.equal(callbacks.validateToken(sessionId, invocationId, callbackToken), true);
  assert.equal(threadCtx.tokens.has(invocationId), true);
  const record = threadCtx.tokens.get(invocationId);
  assert.ok(record.expiresAt > Date.now(), "expiresAt should be extended while active");

  // When the invocation finishes, retireInvocation reclaims the token
  assert.equal(callbacks.retireInvocation(sessionId, invocationId), true);
  assert.equal(threadCtx.tokens.has(invocationId), false);
  assert.equal(callbacks.validateToken(sessionId, invocationId, callbackToken), false);

  callbacks.unregisterThread(sessionId);
});

test("postMessage rejects cross-thread callbacks (Thread Affinity guard)", () => {
  const sseEvents = [];
  const fakeRes = {
    destroyed: false,
    writableEnded: false,
    write(chunk) {
      sseEvents.push(chunk);
      return true;
    },
  };
  const sessionId = "session-guard-1";
  const worklist = ["codex"];
  const controller = new AbortController();
  const threadCtx = {
    sessionId,
    res: fakeRes,
    worklist,
    controller,
    a2aCount: 0,
    tokens: new Map(),
  };
  callbacks.registerThread(sessionId, threadCtx);

  const appended = [];
  const appendFn = (sid, msg) => appended.push({ sid, msg });

  // Mismatched threadId must be rejected
  const ok = callbacks.postMessage("wrong-thread", "inv-1", "hello", {
    appendToSession: appendFn,
  });

  assert.equal(ok, false, "cross-thread postMessage should return false");
  assert.equal(appended.length, 0, "cross-thread message should not be persisted");
  assert.equal(sseEvents.length, 0, "cross-thread message should not be broadcast at all");

  callbacks.unregisterThread(sessionId);
});

test("postMessage allows callbacks for the bound thread (stamped by registerThread)", () => {
  const sseEvents = [];
  const fakeRes = {
    destroyed: false,
    writableEnded: false,
    write(chunk) {
      sseEvents.push(chunk);
      return true;
    },
  };
  const sessionId = "session-guard-2";
  const worklist = ["codex"];
  const controller = new AbortController();
  const threadCtx = {
    sessionId,
    res: fakeRes,
    worklist,
    controller,
    a2aCount: 0,
    tokens: new Map(),
  };
  callbacks.registerThread(sessionId, threadCtx);

  const appended = [];
  const appendFn = (sid, msg) => appended.push({ sid, msg });

  const ok = callbacks.postMessage(sessionId, "inv-1", "hello", {
    appendToSession: appendFn,
  });

  assert.equal(ok.ok, true);
  assert.equal(ok.handoff.status, "none");
  assert.equal(appended.length, 1);
  // sendSse writes two lines per event (event: + data:), so count by event name.
  const eventNames = sseEvents
    .filter((line) => line.startsWith("event: "))
    .map((line) => line.trim());
  assert.deepEqual(eventNames, ["event: message", "event: memory-metrics"]);

  callbacks.unregisterThread(sessionId);
});

test("prompt template uses the cross-platform callback client", () => {
  const instructions = callbacks.buildCallbackInstructions("http://127.0.0.1:8787");
  assert.match(instructions, /\$SHIFT_THREAD_ID/);
  assert.match(instructions, /node scripts\/callback-client\.js post-message/);
  assert.doesNotMatch(instructions, /curl -X POST/);
  assert.match(instructions, /TTL/);
});

// ── Context health + sealer integration (lesson 08 Phase 2) ─────

test("chat endpoint emits context-warning when fillRatio crosses warn threshold", async () => {
  // Tiny capacity so even a small chunk triggers the warn threshold.
  const prevCapacity = process.env.SHIFT_TEST_CAPACITY;
  process.env.SHIFT_TEST_CAPACITY = "20";

  try {
    await withServer(
      {
        spawnRunner(_command, _args) {
          const child = createMockChild();
          process.nextTick(() => {
            // capacity 20 tokens × 4 chars/token = 80 char capacity
            // 25 chars output → ratio 25/80 = 0.31 (under warn)
            // 60 chars output → ratio 60/80 = 0.75 (under warn, since warn is 0.85)
            // 80 chars output → ratio 80/80 = 1.0 (above action 0.90, triggers seal)
            child.stdout.write(
              JSON.stringify({
                type: "text.delta",
                agent: "opencode",
                invocationId: "inv-warn",
                text: "x".repeat(80),
              }) + "\n"
            );
            child.emit("close", 0, null);
          });
          return child;
        },
      },
      async (baseUrl) => {
        const response = await chatInNewProjectSession(baseUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent: "opencode", prompt: "hi" }),
        });
        const text = await response.text();
        // We expect context-warning (or sealed, depending on ratio) because
        // the small test capacity forces the ratio above 0.85.
        const hasContextEvent = /event: (context-warning|sealed)/.test(text);
        assert.ok(
          hasContextEvent,
          `expected context-warning or sealed event in stream, got: ${text.slice(-500)}`
        );
      }
    );
  } finally {
    if (prevCapacity === undefined) delete process.env.SHIFT_TEST_CAPACITY;
    else process.env.SHIFT_TEST_CAPACITY = prevCapacity;
  }
});

test("chat endpoint terminates the chain with sealed event when action threshold crossed", async () => {
  // Very tiny capacity so the very first stdout chunk pushes ratio past 0.90.
  const prevCapacity = process.env.SHIFT_TEST_CAPACITY;
  process.env.SHIFT_TEST_CAPACITY = "20";

  try {
    await withServer(
      {
        spawnRunner(_command, _args) {
          const child = createMockChild();
          process.nextTick(() => {
            // 80 chars × 4 chars/token / 20 tokens capacity = ratio 4.0, well past 0.90
            child.stdout.write(
              JSON.stringify({
                type: "text.delta",
                agent: "codex",
                invocationId: "inv-seal",
                text: "x".repeat(80),
              }) + "\n"
            );
            child.stdout.write(
              JSON.stringify({
                type: "text.delta",
                agent: "codex",
                invocationId: "inv-seal",
                text: "\n@sage please continue",
              }) + "\n"
            );
            child.emit("close", 0, null);
          });
          return child;
        },
      },
      async (baseUrl) => {
        const response = await chatInNewProjectSession(baseUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent: "codex", prompt: "start" }),
        });
        const text = await response.text();
        // Seal lifecycle: pre-call rotate and/or post/physical seal — never silent drop.
        assert.match(text, /event: (?:window-sealed|sealed)/);
        assert.match(
          text,
          /"reason":"(context overflow|pre-call-projected|physical-ceiling|post-turn-[^"]+|physical-ceiling-empty)"/
        );
        // User still gets non-empty assistant text (or explicit retryable error).
        assert.ok(
          /"text":"x{10,}/.test(text) || /retryable":true/.test(text),
          "expected non-empty assistant stream or retryable error after seal pressure"
        );
      }
    );
  } finally {
    if (prevCapacity === undefined) delete process.env.SHIFT_TEST_CAPACITY;
    else process.env.SHIFT_TEST_CAPACITY = prevCapacity;
  }
});

test("empty exact-context emergency completes old invocation before one-shot replay", async () => {
  const previousCapacity = process.env.SHIFT_TEST_CAPACITY;
  process.env.SHIFT_TEST_CAPACITY = "1000";
  let attempt = 0;
  try {
    await withServer(
      {
        initialSessionIds: ["session-empty-emergency"],
        spawnRunner() {
          attempt += 1;
          const child = createMockChild();
          child.kill = () => {
            process.nextTick(() => child.emit("close", null, "SIGTERM"));
            return true;
          };
          process.nextTick(() => {
            if (attempt === 1) {
              child.stdout.write(
                `${JSON.stringify({
                  type: "usage.update",
                  agent: "codex",
                  invocationId: "provider-inv-1",
                  scope: "turn",
                  mode: "cumulative",
                  counterScope: "provider-session",
                  inputTokens: 900,
                  outputTokens: 90,
                  totalTokens: 990,
                  contextTokens: 990,
                  contextTokensExact: true,
                })}\n`
              );
              child.stdout.write("\n");
              return;
            }
            child.stdout.write(
              `${JSON.stringify({
                type: "text.delta",
                agent: "codex",
                invocationId: "provider-inv-2",
                text: "replayed successfully",
              })}\n`
            );
            child.stdout.write(
              `${JSON.stringify({
                type: "usage.update",
                agent: "codex",
                invocationId: "provider-inv-2",
                scope: "turn",
                mode: "cumulative",
                counterScope: "provider-session",
                inputTokens: 100,
                outputTokens: 20,
                totalTokens: 120,
                contextTokens: 120,
                contextTokensExact: true,
              })}\n`
            );
            child.emit("close", 0, null);
          });
          return child;
        },
      },
      async (baseUrl, { memoryDbFile }) => {
        const response = await startChat(baseUrl, {
          sessionId: "session-empty-emergency",
          agent: "codex",
          prompt: "continue",
        });
        const body = await response.text();
        assert.match(body, /replayed successfully/);
        assert.doesNotMatch(body, /Invocation .* is not active/);
        assert.equal(attempt, 2);

        const storage = createStorage({ file: memoryDbFile });
        try {
          const invocations = storage.invocations.listForThread("session-empty-emergency");
          assert.equal(invocations.length, 2);
          assert.ok(invocations.every((item) => item.isTerminal));
          assert.equal(invocations[1].state, "completed");
          assert.ok(storage.windows.listForThread("session-empty-emergency").length >= 2);
        } finally {
          storage.close();
        }
      }
    );
  } finally {
    if (previousCapacity === undefined) delete process.env.SHIFT_TEST_CAPACITY;
    else process.env.SHIFT_TEST_CAPACITY = previousCapacity;
  }
});

test("stream handler failure closes the invocation as failed without crashing the server", async () => {
  await withServer(
    {
      spawnRunner() {
        const child = createMockChild();
        child.kill = () => {
          process.nextTick(() => child.emit("close", null, "SIGTERM"));
          return true;
        };
        process.nextTick(() => {
          child.stdout.write(
            `${JSON.stringify({
              type: "text.delta",
              agent: "codex",
              invocationId: "inv-stream-fail",
              text: "partial ",
            })}\n`
          );
          // Pipe failure mid-stream must not escape as an uncaught exception.
          child.stdout.emit("error", new Error("EMFILE: too many open files"));
        });
        return child;
      },
    },
    async (baseUrl, { memoryDbFile }) => {
      const created = await createProjectSession(baseUrl).then((response) => response.json());
      const response = await startChat(baseUrl, {
        sessionId: created.session.id,
        agent: "codex",
        prompt: "hello",
      });
      const body = await response.text();
      assert.match(body, /event: error/);
      assert.match(body, /stdout stream failed/);
      assert.match(body, /invocation closed as failed/);
      assert.doesNotMatch(body, /event: done/);

      const storage = createStorage({ file: memoryDbFile });
      try {
        const invocations = storage.invocations.listForThread(created.session.id);
        assert.equal(invocations.length, 1);
        assert.equal(invocations[0].state, "failed");
        assert.equal(invocations[0].terminalReason, "stream-handler-failed");
        assert.equal(invocations[0].failureStage, "stream_handler");
        assert.equal(invocations[0].errorCode, "stream_handler_failed");
        assert.ok(invocations[0].isTerminal);
      } finally {
        storage.close();
      }

      // The failure must stay request-scoped: the server keeps serving.
      const agentsResponse = await fetch(`${baseUrl}/api/agents`);
      assert.equal(agentsResponse.status, 200);
    }
  );
});

function patchAppendEventToFail(storage, failingKinds) {
  const kinds = new Set(failingKinds);
  const original = storage.invocations.appendEvent.bind(storage.invocations);
  storage.invocations.appendEvent = (event) => {
    if (kinds.has(event.kind)) {
      throw new Error(`sqlite persist failed: ${event.kind}`);
    }
    return original(event);
  };
}

test("buffered stream persist failure closes as stream-handler-failed without crashing the server", async () => {
  await withServer(
    {
      patchStorage(storage) {
        patchAppendEventToFail(storage, ["text.delta"]);
      },
      spawnRunner() {
        const child = createMockChild();
        child.kill = () => {
          process.nextTick(() => child.emit("close", 0, null));
          return true;
        };
        process.nextTick(() => {
          child.stdout.write(
            `${JSON.stringify({
              type: "text.delta",
              agent: "codex",
              invocationId: "inv-persist-flush",
              text: "partial ",
            })}\n`
          );
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl, { memoryDbFile }) => {
      const created = await createProjectSession(baseUrl).then((response) => response.json());
      const response = await startChat(baseUrl, {
        sessionId: created.session.id,
        agent: "codex",
        prompt: "hello",
      });
      const body = await response.text();
      assert.match(body, /event: error/);
      assert.match(body, /invocation closed as failed/);
      assert.doesNotMatch(body, /event: done/);
      assert.doesNotMatch(body, /Invocation .* is not active/);

      const storage = createStorage({ file: memoryDbFile });
      try {
        const invocations = storage.invocations.listForThread(created.session.id);
        assert.equal(invocations.length, 1);
        assert.equal(invocations[0].state, "failed");
        assert.equal(invocations[0].terminalReason, "stream-handler-failed");
        assert.equal(invocations[0].failureStage, "stream_handler");
        assert.equal(invocations[0].errorCode, "stream_handler_failed");
        assert.ok(invocations[0].isTerminal);
      } finally {
        storage.close();
      }

      const agentsResponse = await fetch(`${baseUrl}/api/agents`);
      assert.equal(agentsResponse.status, 200);
    }
  );
});

test("persist failure during empty emergency does not replay a second invocation", async () => {
  const previousCapacity = process.env.SHIFT_TEST_CAPACITY;
  process.env.SHIFT_TEST_CAPACITY = "1000";
  let attempt = 0;
  try {
    await withServer(
      {
        initialSessionIds: ["session-persist-empty-emergency"],
        patchStorage(storage) {
          patchAppendEventToFail(storage, ["usage.update"]);
        },
        spawnRunner() {
          attempt += 1;
          const child = createMockChild();
          child.kill = () => {
            process.nextTick(() => child.emit("close", null, "SIGTERM"));
            return true;
          };
          process.nextTick(() => {
            child.stdout.write(
              `${JSON.stringify({
                type: "usage.update",
                agent: "codex",
                invocationId: "provider-inv-persist",
                scope: "turn",
                mode: "cumulative",
                counterScope: "provider-session",
                inputTokens: 900,
                outputTokens: 90,
                totalTokens: 990,
                contextTokens: 990,
                contextTokensExact: true,
              })}\n`
            );
            child.stdout.write("\n");
          });
          return child;
        },
      },
      async (baseUrl, { memoryDbFile }) => {
        const response = await startChat(baseUrl, {
          sessionId: "session-persist-empty-emergency",
          agent: "codex",
          prompt: "continue",
        });
        const body = await response.text();
        assert.match(body, /event: error/);
        assert.match(body, /invocation closed as failed/);
        assert.doesNotMatch(body, /replayed successfully/);
        assert.doesNotMatch(body, /Invocation .* is not active/);
        assert.equal(attempt, 1);

        const storage = createStorage({ file: memoryDbFile });
        try {
          const invocations = storage.invocations.listForThread("session-persist-empty-emergency");
          assert.equal(invocations.length, 1);
          assert.equal(invocations[0].state, "failed");
          assert.equal(invocations[0].terminalReason, "stream-handler-failed");
          assert.equal(invocations[0].failureStage, "stream_handler");
          assert.ok(invocations[0].isTerminal);
        } finally {
          storage.close();
        }

        const agentsResponse = await fetch(`${baseUrl}/api/agents`);
        assert.equal(agentsResponse.status, 200);
      }
    );
  } finally {
    if (previousCapacity === undefined) delete process.env.SHIFT_TEST_CAPACITY;
    else process.env.SHIFT_TEST_CAPACITY = previousCapacity;
  }
});

// ── Phase 3: transcript callback endpoints ─────────────────────

/**
 * Helper: run a chat with a long-running mock so callback requests can fire
 * while the agent is still active. Returns { baseUrl, captured, close } where
 * captured.invocationId and captured.callbackToken are set once spawnRunner is
 * called.
 */
async function withActiveChat(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase3-"));
  const prevDir = process.env.SHIFT_TRANSCRIPT_DIR;
  process.env.SHIFT_TRANSCRIPT_DIR = tmpDir;

  const captured = { env: null, kill: null };

  try {
    await withServer(
      {
        initialSessionIds: ["phase3-active-session"],
        spawnRunner(command, args, options = {}) {
          captured.env = options.env;
          const child = createMockChild();
          let killed = false;
          child.kill = (sig) => {
            if (killed) return true;
            killed = true;
            setImmediate(() => child.emit("close", null, sig || "SIGTERM"));
            return true;
          };
          captured.kill = () => child.kill("SIGTERM");
          captured.child = child;
          return child;
        },
      },
      async (baseUrl) => {
        const knownSessionId = "phase3-active-session";
        const observer = new AbortController();

        // Fire the chat in background; the mock holds the child open so we can
        // poke the callback endpoints while it's "running".
        const chatPromise = startChat(
          baseUrl,
          {
            agent: "opencode",
            prompt: "long running task about redis clustering",
            sessionId: knownSessionId,
          },
          { signal: observer.signal }
        );

        // Wait for spawnRunner to be called (env captured)
        const deadline = Date.now() + 2000;
        while (!captured.env && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 20));
        }
        assert.ok(captured.env, "spawnRunner should have been called within 2s");

        // Give the chat handler a moment to finish registerThread/createInvocation
        await new Promise((r) => setTimeout(r, 50));

        try {
          await fn(baseUrl, knownSessionId, captured);
        } finally {
          observer.abort();
          if (captured.kill) captured.kill();
          await chatPromise.catch(() => {});
        }
      }
    );
  } finally {
    if (prevDir === undefined) delete process.env.SHIFT_TRANSCRIPT_DIR;
    else process.env.SHIFT_TRANSCRIPT_DIR = prevDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test("retired Memory callback routes are not exposed", async () => {
  await withServer({}, async (baseUrl) => {
    for (const pathname of ["session-search", "memory-upsert"]) {
      const resp = await fetch(`${baseUrl}/api/callbacks/${pathname}`);
      assert.equal(resp.status, 404);
    }
  });
});

test("/api/callbacks/recall-search returns the authenticated v2 agent contract", async () => {
  await withActiveChat(async (baseUrl, sid, captured) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const resp = await fetch(`${baseUrl}/api/callbacks/recall-search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Callback-Token": captured.env.SHIFT_CALLBACK_TOKEN,
      },
      body: JSON.stringify({
        sessionId: sid,
        invocationId: captured.env.SHIFT_INVOCATION_ID,
        operationId: "server-test-recall-success",
        query: "redis clustering",
        layers: ["memory", "message", "evidence"],
        limit: 10,
      }),
    });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.version, 2);
    assert.equal(body.query, "redis clustering");
    assert.ok(body.hits.length >= 1);
    assert.ok(body.hits.every((hit) => typeof hit.finalScore === "number"));
    assert.equal(body.availability.channels.vector.reason, "disabled");
    assert.equal(body.stats.returnedCount, body.hits.length);
  });
});

test("/api/callbacks/recall-search rejects an invalid callback token", async () => {
  await withServer({}, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/callbacks/recall-search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Callback-Token": "wrong",
      },
      body: JSON.stringify({
        sessionId: "x",
        invocationId: "y",
        operationId: "server-test-recall-invalid-token",
        query: "previous decision",
      }),
    });
    assert.equal(resp.status, 401);
  });
});

test("/api/callbacks/list-invocations returns agent + state metadata", async () => {
  await withActiveChat(async (baseUrl, sid, captured) => {
    // Give invocation-start time to flush
    await new Promise((r) => setTimeout(r, 200));

    const resp = await fetch(
      `${baseUrl}/api/callbacks/list-invocations?` +
        `sessionId=${encodeURIComponent(sid)}&` +
        `invocationId=${encodeURIComponent(captured.env.SHIFT_INVOCATION_ID)}`,
      { headers: { "X-Callback-Token": captured.env.SHIFT_CALLBACK_TOKEN } }
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.ok(Array.isArray(body.invocations));
    // The active invocation should appear (in-flight, no end event yet)
    const active = body.invocations.find(
      (i) => i.invocationId === captured.env.SHIFT_INVOCATION_ID
    );
    assert.ok(
      active,
      `active invocation should be listed, got: ${JSON.stringify(body.invocations)}`
    );
    assert.equal(active.agent, "codex");
    assert.ok(active.startedAt);
    assert.equal(active.endedAt, null);
    assert.equal(active.state, null);
    assert.ok(active.eventCount >= 1);
  });
});

test("/api/callbacks/read-invocation returns paginated events", async () => {
  await withActiveChat(async (baseUrl, sid, captured) => {
    // Give invocation-start time to flush
    await new Promise((r) => setTimeout(r, 200));

    const invId = captured.env.SHIFT_INVOCATION_ID;
    const resp = await fetch(
      `${baseUrl}/api/callbacks/read-invocation?` +
        `sessionId=${encodeURIComponent(sid)}&` +
        `invocationId=${encodeURIComponent(invId)}&` +
        `targetInvocationId=${encodeURIComponent(invId)}&` +
        `from=0&limit=10`,
      { headers: { "X-Callback-Token": captured.env.SHIFT_CALLBACK_TOKEN } }
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.invocationId, invId);
    assert.equal(body.from, 0);
    assert.equal(body.limit, 10);
    assert.ok(body.total >= 1);
    assert.ok(body.events.length >= 1);
    // The first event should be invocation-start
    assert.equal(body.events[0].kind, "invocation-start");
  });
});

test("/api/callbacks/read-invocation requires targetInvocationId", async () => {
  await withActiveChat(async (baseUrl, sid, captured) => {
    const resp = await fetch(
      `${baseUrl}/api/callbacks/read-invocation?` +
        `sessionId=${encodeURIComponent(sid)}&` +
        `invocationId=${encodeURIComponent(captured.env.SHIFT_INVOCATION_ID)}`,
      { headers: { "X-Callback-Token": captured.env.SHIFT_CALLBACK_TOKEN } }
    );
    assert.equal(resp.status, 400);
  });
});

test("/api/callbacks/read-invocation pagination slices correctly", async () => {
  await withActiveChat(async (baseUrl, sid, captured) => {
    // Feed hard-boundary canonical provider events through the active
    // SQLite-only chat path so pagination never relies on transcript fallback
    // or waits for text-delta coalescing at invocation end.
    const invId = captured.env.SHIFT_INVOCATION_ID;
    for (let i = 0; i < 10; i++) {
      captured.child.stdout.write(
        `${JSON.stringify({
          type: "tool.started",
          toolName: "read",
          toolId: `pagination-tool-${i}`,
          args: { path: `file-${i}.js` },
        })}\n`
      );
    }
    await new Promise((r) => setTimeout(r, 100));

    const resp = await fetch(
      `${baseUrl}/api/callbacks/read-invocation?` +
        `sessionId=${encodeURIComponent(sid)}&` +
        `invocationId=${encodeURIComponent(invId)}&` +
        `targetInvocationId=${encodeURIComponent(invId)}&` +
        `from=2&limit=3`,
      { headers: { "X-Callback-Token": captured.env.SHIFT_CALLBACK_TOKEN } }
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.from, 2);
    assert.equal(body.limit, 3);
    assert.ok(body.events.length === 3, `expected 3 events, got ${body.events.length}`);
  });
});

test("buildCallbackInstructions exposes MCP-only Memory commands", () => {
  const tpl = callbacks.buildCallbackInstructions("http://127.0.0.1:8787");
  assert.match(tpl, /recall_search/);
  assert.match(tpl, /callback-client\.js list-invocations/);
  assert.match(tpl, /callback-client\.js read-invocation/);
  assert.match(tpl, /memory_write/);
  assert.doesNotMatch(tpl, /callback-client\.js (?:session-search|memory-upsert)/);
  assert.doesNotMatch(tpl, /callback-client\.js memory-invalidate/);
  assert.match(tpl, /不要凭印象猜/);
});

// ── Phase 4: Session Bootstrap ──────────────────────────────────

test("chat endpoint injects bootstrap packet (identity + recall rule) into first agent's prompt", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-inject-"));
  const prevDir = process.env.SHIFT_TRANSCRIPT_DIR;
  process.env.SHIFT_TRANSCRIPT_DIR = tmpDir;

  let capturedPrompt = null;

  try {
    await withServer(
      {
        initialSessionIds: ["bootstrap-test-session"],
        spawnRunner(command, args) {
          // Last positional arg is the prompt
          capturedPrompt = args[args.length - 1];
          const child = createMockChild();
          process.nextTick(() => {
            child.stdout.write("ok");
            child.emit("close", 0, null);
          });
          return child;
        },
      },
      async (baseUrl) => {
        const response = await startChat(baseUrl, {
          agent: "codex",
          prompt: "hello world",
          sessionId: "bootstrap-test-session",
        });
        await response.text();
      }
    );

    assert.ok(capturedPrompt, "spawnRunner should have been called");
    // Agent persona identity (from identities/*.md) comes first
    assert.match(capturedPrompt, /<!-- Agent Identity: codex \/ Codex -->/);
    assert.match(capturedPrompt, /<!-- \/Agent Identity -->/);
    // Session coords section
    assert.match(capturedPrompt, /<!-- Session Identity -->/);
    assert.match(capturedPrompt, /Thread: bootstrap-test-session/);
    assert.match(capturedPrompt, /Session: bootstrap-test-session/);
    assert.match(capturedPrompt, /Agent: Codex/);
    // Digest section (empty for new session with fresh dir)
    assert.match(capturedPrompt, /<!-- Digest -->/);
    assert.match(capturedPrompt, /第一个 invocation/);
    // Recall rule
    assert.match(capturedPrompt, /<!-- 回忆铁律/);
    assert.match(capturedPrompt, /不要凭印象猜/);
    // User prompt still in there
    assert.match(capturedPrompt, /hello world/);
    // Order: agent identity before session identity
    assert.ok(
      capturedPrompt.indexOf("<!-- Agent Identity:") <
        capturedPrompt.indexOf("<!-- Session Identity -->"),
      "agent identity should precede session identity"
    );
  } finally {
    if (prevDir === undefined) delete process.env.SHIFT_TRANSCRIPT_DIR;
    else process.env.SHIFT_TRANSCRIPT_DIR = prevDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("bootstrap digest lists prior invocations when chat is re-entered with same sessionId", async () => {
  const sessionId = "bootstrap-resume-test";
  const prompts = [];
  await withServer(
    {
      initialSessionIds: [sessionId],
      spawnRunner(command, args) {
        prompts.push(args[args.length - 1]);
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write(
            `${JSON.stringify({ type: "text.delta", text: `done-${prompts.length}` })}\n`
          );
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      for (const prompt of ["first", "second"]) {
        await (await startChat(baseUrl, { agent: "opencode", prompt, sessionId })).text();
      }
    }
  );

  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /第一个 invocation/);
  assert.match(prompts[1], /<!-- Digest/);
  assert.doesNotMatch(prompts[1], /第一个 invocation/);
});

// ── Recall (memory/回忆) tests ────────────────────────────────

test("buildCallbackInstructions includes SHIFT context and recall commands", () => {
  const instructions = callbacks.buildCallbackInstructions("http://example.test", "session-xyz");
  assert.match(instructions, /\$SHIFT_THREAD_ID/);
  assert.match(instructions, /recall_search/);
  assert.match(instructions, /callback-client\.js post-message/);
  assert.match(instructions, /callback-client\.js list-invocations/);
  assert.match(instructions, /callback-client\.js read-invocation/);
  assert.doesNotMatch(instructions, /callback-client\.js (?:session-search|memory-upsert)/);
  assert.doesNotMatch(instructions, /callback-client\.js memory-write/);
  assert.match(instructions, /Active Memories/);
});

test("chat records invocation events and recall routes expose them (no token = frontend path)", async () => {
  await withServer(
    {
      spawnRunner() {
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write(
            JSON.stringify({
              type: "text.delta",
              agent: "codex",
              invocationId: "recall-1",
              text: "hello recall",
            }) + "\n"
          );
          child.stderr.write("a stderr line\n");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const chat = await chatInNewProjectSession(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "codex", prompt: "remember this" }),
      });
      const chatText = await chat.text();
      const sidMatch = chatText.match(/"sessionId":"([^"]+)"/);
      assert.ok(sidMatch, "expected session id");
      const sid = sidMatch[1];
      const invMatch = chatText.match(
        /event: agent-start\ndata: \{"agent":"codex","invocationId":"([^"]+)"[^\n]*\}/
      );
      assert.ok(invMatch, "expected agent-start with invocationId");
      const invId = invMatch[1];

      const listRes = await fetch(`${baseUrl}/api/callbacks/list-invocations?sessionId=${sid}`);
      const list = await listRes.json();
      assert.equal(listRes.status, 200);
      assert.equal(list.invocations.length, 1);
      assert.equal(list.invocations[0].invocationId, invId);
      assert.equal(list.invocations[0].agent, "codex");
      assert.equal(list.invocations[0].state, "completed");
      assert.ok(
        list.invocations[0].eventCount >= 3,
        "should have start + text.delta + stderr + end events"
      );

      const readRes = await fetch(
        `${baseUrl}/api/callbacks/read-invocation?sessionId=${sid}&targetInvocationId=${invId}`
      );
      const read = await readRes.json();
      assert.equal(readRes.status, 200);
      assert.equal(read.invocationId, invId);
      assert.equal(read.total, read.events.length);
      const kinds = read.events.map((e) => e.kind);
      assert.ok(kinds.includes("invocation-start"));
      assert.ok(kinds.includes("text.delta"));
      assert.ok(kinds.includes("stderr"));
      assert.ok(kinds.includes("invocation-end"));

      const histRes = await fetch(`${baseUrl}/api/messages?sessionId=${sid}`);
      const hist = await histRes.json();
      const assistant = hist.messages.find((m) => m.role === "assistant");
      assert.ok(assistant, "should have an assistant message");
      assert.equal(assistant.invocationId, invId);
    }
  );
});

test("read-invocation returns 404 for unknown invocation", async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(
      `${baseUrl}/api/callbacks/read-invocation?sessionId=any&targetInvocationId=missing`
    );
    assert.equal(res.status, 404);
  });
});

test("list-invocations requires sessionId", async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/callbacks/list-invocations`);
    assert.equal(res.status, 400);
  });
});

test("read-invocation requires targetInvocationId", async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/callbacks/read-invocation?sessionId=any`);
    assert.equal(res.status, 400);
  });
});

test("recall routes reject invalid agent token when one is provided", async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(
      `${baseUrl}/api/callbacks/list-invocations?sessionId=s&invocationId=i`,
      {
        headers: { "x-callback-token": "bad" },
      }
    );
    assert.equal(res.status, 401);
  });
});

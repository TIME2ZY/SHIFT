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
const {
  hashUserGoal,
  hashSolutionBaseline,
} = require("../src/agents/outcome-evidence-gate");
const { hashImplementationPlan } = require("../src/agents/implementation-plan-gate");
const { createStorage } = require("../src/storage");
const { prepareCleanEpoch } = require("../src/storage/offline/clean-epoch");

const TEST_UI_TOKEN = "test-ui-token";
const nativeFetch = globalThis.fetch.bind(globalThis);

function fetch(input, init = {}) {
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
  const sessionsFile = path.join(tmpDir, "sessions.json");
  const initialSessionIds = Array.isArray(options.initialSessionIds)
    ? options.initialSessionIds
    : [];
  const serverOptions = { ...options };
  delete serverOptions.initialSessionIds;
  const memoryDbFile = path.join(tmpDir, "shift.sqlite");
  prepareCleanEpoch({ file: memoryDbFile });
  if (initialSessionIds.length > 0) {
    const storage = createStorage({ file: memoryDbFile });
    try {
      for (const sessionId of initialSessionIds) storage.threads.create({ id: sessionId });
    } finally {
      storage.close();
    }
  }
  const prevTranscriptDir = process.env.SHIFT_TRANSCRIPT_DIR;
  if (!prevTranscriptDir) {
    process.env.SHIFT_TRANSCRIPT_DIR = path.join(tmpDir, "transcripts");
  }
  const server = createServer({
    sessionsFile,
    memoryDbFile,
    worktreeManager: options.worktreeManager || createPassthroughWorktreeManager(),
    invocationsFile: path.join(tmpDir, "invocations.json"),
    sessionMapRoot: path.join(tmpDir, "session-maps"),
    uiToken: TEST_UI_TOKEN,
    ...serverOptions,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`, { memoryDbFile });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await server.closeStorageContext?.();
    if (!prevTranscriptDir) {
      delete process.env.SHIFT_TRANSCRIPT_DIR;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test("serves fixed agent list", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agents`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(
      body.agents.map((agent) => agent.id),
      ["codex", "gemini", "grok", "opencode"]
    );
    // Every agent must surface a non-empty description so the UI can show it.
    for (const agent of body.agents) {
      assert.ok(
        agent.description && agent.description.length > 0,
        `Agent ${agent.id} missing description`
      );
      // Identity pack metadata (role / duties) comes from src/agents/identities/*.md
      assert.ok(agent.role && agent.role.length > 0, `Agent ${agent.id} missing role`);
      assert.ok(
        Array.isArray(agent.duties) && agent.duties.length > 0,
        `Agent ${agent.id} missing duties`
      );
      assert.ok(Array.isArray(agent.boundaries), `Agent ${agent.id} missing boundaries array`);
      assert.ok(agent.workflowRole, `Agent ${agent.id} missing workflow role`);
      assert.ok(
        Array.isArray(agent.workflowCapabilities) && agent.workflowCapabilities.length > 0,
        `Agent ${agent.id} missing workflow capabilities`
      );
      assert.ok(
        Array.isArray(agent.workflowResponsibilities) && agent.workflowResponsibilities.length > 0,
        `Agent ${agent.id} missing workflow responsibilities`
      );
    }
  });
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

      const reactRedirect = await nativeFetch(`${baseUrl}/react/`, { redirect: "manual" });
      assert.equal(reactRedirect.status, 308);
      assert.equal(reactRedirect.headers.get("location"), "/");

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
      const response = await nativeFetch(`${baseUrl}/api/chat`, {
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
      const unsafe = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "codex", prompt: "probe", sessionId: ".." }),
      });
      assert.equal(unsafe.status, 400);

      const unknown = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "codex", prompt: "probe", sessionId: "unknown-session" }),
      });
      assert.equal(unknown.status, 404);
      assert.equal(spawnCount, 0);
    }
  );
});

test("rejects unknown agent", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "unknown", prompt: "hello" }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.error, /Unsupported agent/);
  });
});

test("streams child stdout and exit events", async () => {
  const calls = [];
  const child = createMockChild();

  await withServer(
    {
      spawnRunner(command, args) {
        calls.push({ command, args });
        process.nextTick(() => {
          child.stdout.write("hello");
          child.stderr.write("thinking");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "opencode", prompt: "hello" }),
      });
      const text = await response.text();

      assert.equal(response.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, process.execPath);
      assert.equal(
        calls[0].args[0],
        path.resolve(__dirname, "..", "src", "agents", "invoke-cli.js")
      );
      assert.equal(calls[0].args[1], "--agent");
      assert.equal(calls[0].args[2], "opencode");
      assert.ok(
        calls[0].args[3].endsWith("hello"),
        `Expected last arg to end with "hello", got: ${calls[0].args[3]?.slice(-50)}`
      );
      assert.ok(
        calls[0].args[3].includes("APPLICATION SKILL"),
        "Expected augmented prompt to contain APPLICATION SKILL marker"
      );
      assert.match(text, /event: stdout\ndata: \{"text":"hello"\}/);
      assert.match(text, /event: stderr\ndata: \{"text":"thinking"\}/);
      assert.match(text, /event: exit\ndata: \{"code":0,"signal":null\}/);
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
              agent: "opencode",
              invocationId: "inv-test",
              text: "partial ",
            }) + "\n"
          );
          child.stdout.write(
            JSON.stringify({
              type: "text.delta",
              agent: "opencode",
              invocationId: "inv-test",
              text: "answer",
            }) + "\n"
          );
          child.stdout.write(
            JSON.stringify({
              type: "usage.update",
              agent: "opencode",
              invocationId: "inv-test",
              provider: "opencode",
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
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "opencode", prompt: "hello" }),
      });
      const text = await response.text();

      assert.equal(response.status, 200);
      assert.equal(
        calls[0].args[0],
        path.resolve(__dirname, "..", "src", "agents", "invoke-cli.js")
      );
      assert.equal(calls[0].args[1], "--agent");
      assert.equal(calls[0].args[2], "opencode");
      assert.ok(
        calls[0].args[3].includes("hello"),
        `Expected prompt to contain "hello", got: ${calls[0].args[3]?.slice(-50)}`
      );
      assert.ok(
        calls[0].args[3].includes("APPLICATION SKILL"),
        "Expected augmented prompt to contain APPLICATION SKILL marker"
      );
      assert.ok(
        calls[0].args[3].includes("MCP 回调工具说明"),
        "Expected prompt to contain callback instructions"
      );
      // Soft collab rules must be present on the first (non-A2A) turn.
      assert.match(calls[0].args[3], /<!-- Collaboration Rules -->/);
      assert.match(
        text,
        /event: message\ndata: \{"agent":"opencode","role":"assistant","text":"partial "\}/
      );
      assert.match(
        text,
        /event: message\ndata: \{"agent":"opencode","role":"assistant","text":"answer"\}/
      );
      // Verify session event is emitted
      const sessionMatch = text.match(/event: session\ndata: \{"sessionId":"([^"]+)"\}/);
      assert.ok(sessionMatch, "Expected SSE session event with sessionId");
      capturedSessionId = sessionMatch[1];

      // Verify messages can be retrieved via /api/messages?sessionId=
      const historyResponse = await fetch(`${baseUrl}/api/messages?sessionId=${capturedSessionId}`);
      const history = await historyResponse.json();
      assert.equal(history.messages.length, 2);
      assert.equal(history.messages[0].role, "user");
      assert.equal(history.messages[0].agent, "opencode");
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
      const response = await fetch(`${baseUrl}/api/chat`, {
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
      const response = await fetch(`${baseUrl}/api/chat`, {
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

test("chat history stores only assistant text reconstructed from text.delta", async () => {
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
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "opencode", prompt: "hello" }),
      });
      const sse = await response.text();
      const sid = sse.match(/"sessionId":"([^"]+)"/)[1];
      const history = await (await fetch(`${baseUrl}/api/messages?sessionId=${sid}`)).json();
      const assistant = history.messages.find((msg) => msg.role === "assistant");
      assert.equal(assistant.content, "final answer");
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
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "opencode", prompt: "hello chunks" }),
      });
      const text = await response.text();

      assert.match(
        text,
        /event: message\ndata: \{"agent":"opencode","role":"assistant","text":"line 1\\n\\n"\}/
      );
      assert.match(
        text,
        /event: message\ndata: \{"agent":"opencode","role":"assistant","text":" {4}code-ish indent\\n"\}/
      );
      assert.match(
        text,
        /event: message\ndata: \{"agent":"opencode","role":"assistant","text":"- list item"\}/
      );
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
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "all", prompt: "compare" }),
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
      const response = await fetch(`${baseUrl}/api/chat`, {
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

test("chat endpoint passes previous agent output to A2A-routed agent", async () => {
  const prompts = [];

  await withServer(
    {
      spawnRunner(command, args) {
        prompts.push(args[args.length - 1]);
        const child = createMockChild();
        process.nextTick(() => {
          if (args[2] === "codex") {
            child.stdout.write(
              JSON.stringify({
                type: "text.delta",
                agent: "codex",
                invocationId: "inv-a2a-1",
                text: "@Gemini\n请继续实现。\ncodex result",
              }) + "\n"
            );
          } else {
            child.stdout.write(
              JSON.stringify({
                type: "text.delta",
                agent: "gemini",
                invocationId: "inv-a2a-2",
                text: "gemini received",
              }) + "\n"
            );
          }
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "codex", prompt: "build feature" }),
      });
      const text = await response.text();

      assert.equal(response.status, 200);
      assert.equal(prompts.length, 2);
      assert.match(text, /event: a2a-route\ndata: \{[^\n]*"from":"codex"[^\n]*"to":"gemini"/);
      assert.match(text, /event: handoff-parsed\ndata: \{[^\n]*"to":"gemini"/);
      // Soft collab rules on first turn and A2A follow-up turn.
      assert.match(prompts[0], /<!-- Collaboration Rules -->/);
      assert.match(prompts[1], /<!-- Collaboration Rules -->/);
      assert.match(prompts[1], /任务交接/);
      assert.match(prompts[1], /codex result/);
      assert.match(prompts[1], /用户原始请求/);
      assert.match(prompts[1], /build feature/);
      assert.match(prompts[1], /未提供标准/);

      // Handoff system markers must persist so session switch can reload them.
      const sessionId = (text.match(/"sessionId":"([^"]+)"/) || [])[1];
      assert.ok(sessionId);
      const messagesResp = await fetch(
        `${baseUrl}/api/messages?sessionId=${encodeURIComponent(sessionId)}`
      );
      const body = await messagesResp.json();
      const systemRoutes = (body.messages || []).filter(
        (m) => m.role === "system" && m.kind === "a2a-route"
      );
      assert.equal(systemRoutes.length, 1);
      assert.equal(systemRoutes[0].from, "codex");
      assert.equal(systemRoutes[0].to, "gemini");
      assert.match(systemRoutes[0].content, /→/);
    }
  );
});

test("messages endpoint returns empty history when no sessions exist", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/messages`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.messages, []);
  });
});

// ── Session CRUD tests ─────────────────────────────────────────

test("POST /api/sessions creates a new session", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.ok(body.session.id, "session should have an id");
    assert.equal(body.session.title, "");
    assert.deepEqual(body.session.messages, []);
    assert.equal(body.session.messageCount, 0);
    assert.equal(body.session.projectDir, path.resolve(__dirname, ".."));
    assert.ok(body.session.projectKey);
  });
});

test("GET /api/sessions lists all sessions", async () => {
  await withServer({}, async (baseUrl) => {
    // Create two sessions
    await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
    await fetch(`${baseUrl}/api/sessions`, { method: "POST" });

    const response = await fetch(`${baseUrl}/api/sessions`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.sessions.length, 2);
    assert.ok(body.sessions[0].createdAt >= body.sessions[1].createdAt, "sorted newest first");
  });
});

test("GET /api/sessions/:id returns a specific session", async () => {
  await withServer({}, async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
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
    const created = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
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

test("DELETE /api/sessions/:id discards an attached worktree", async () => {
  const calls = [];

  await withServer(
    {
      worktreeManager: {
        ensureWorktree({ baseDir, sessionId }) {
          calls.push(["ensure", sessionId]);
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
          calls.push(["discard", sessionId]);
          return { ok: true, sessionId };
        },
      },
      spawnRunner() {
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write("answer");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-delete-worktree-"));
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: "opencode",
          prompt: "hello",
          projectDir: baseDir,
          useWorktree: true,
        }),
      });
      const text = await response.text();
      const sessionId = text.match(/"sessionId":"([^"]+)"/)[1];

      const deleted = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: "DELETE" });
      assert.equal(deleted.status, 200);
      assert.deepEqual(calls, [
        ["ensure", sessionId],
        ["discard", sessionId],
      ]);
    }
  );
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
      const created = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
      const { session } = await created.json();

      const chatPromise = fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "codex", prompt: "long task", sessionId: session.id }),
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

test("POST /api/chat with explicit sessionId stores messages there", async () => {
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
      const created = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
      const { session } = await created.json();

      // Chat into that session (consume body to wait for stream completion)
      const chatResp = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "codex", prompt: "hello", sessionId: session.id }),
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

test("POST /api/chat reuses a user message for the same clientTurnId", async () => {
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
      const created = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
      const { session } = await created.json();

      async function sendTurn(clientTurnId) {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent: "codex",
            prompt: "repeat exactly",
            sessionId: session.id,
            clientTurnId,
          }),
        });
        assert.equal(response.status, 200);
        return response.text();
      }

      const first = await sendTurn("turn-same");
      const retry = await sendTurn("turn-same");
      const firstTrigger = first.match(/"triggerMessageId":"([^"]+)"/)?.[1];
      const retryTrigger = retry.match(/"triggerMessageId":"([^"]+)"/)?.[1];
      const firstInvocation = first.match(/event: agent-start\ndata: \{"agent":"codex","invocationId":"([^"]+)"/)?.[1];
      const retryInvocation = retry.match(/event: agent-start\ndata: \{"agent":"codex","invocationId":"([^"]+)"/)?.[1];
      assert.ok(firstTrigger);
      assert.equal(retryTrigger, firstTrigger);
      assert.ok(firstInvocation);
      assert.ok(retryInvocation);
      assert.notEqual(retryInvocation, firstInvocation);

      let detail = await fetch(`${baseUrl}/api/sessions/${session.id}`).then((response) =>
        response.json()
      );
      assert.equal(
        detail.session.messages.filter((message) => message.role === "user").length,
        1
      );
      assert.equal(detail.session.messages[0].clientTurnId, "turn-same");

      await sendTurn("turn-intentional-repeat");
      detail = await fetch(`${baseUrl}/api/sessions/${session.id}`).then((response) =>
        response.json()
      );
      assert.equal(
        detail.session.messages.filter((message) => message.role === "user").length,
        2
      );
    }
  );
});

test("POST /api/chat rejects invalid projectDir", async () => {
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
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: "codex",
          prompt: "hello",
          projectDir: path.join(os.tmpdir(), "definitely-missing-project-dir"),
        }),
      });
      const text = await response.text();

      assert.equal(response.status, 400);
      const body = JSON.parse(text);
      assert.match(body.error, /Directory not found/);
    }
  );
});

test("chat binds an unassigned legacy session to the server project before execution", async () => {
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
      assert.equal(before.session.projectDir, "");

      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "legacy-empty-session",
          agent: "codex",
          prompt: "bind project first",
          clientTurnId: "legacy-bind-turn",
        }),
      });
      assert.equal(response.status, 200);
      await response.text();

      const after = await fetch(`${baseUrl}/api/sessions/legacy-empty-session`).then((result) =>
        result.json()
      );
      assert.equal(after.session.projectDir, path.resolve(__dirname, ".."));
      assert.ok(after.session.projectKey);
    }
  );
});

test("project endpoint stores projectDir per session and chat reuses the saved directory", async () => {
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
      const createdA = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
      const { session: sessionA } = await createdA.json();
      const createdB = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
      const { session: sessionB } = await createdB.json();

      let response = await fetch(`${baseUrl}/api/project`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sessionA.id, dir: dirA }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).dir, dirA);

      response = await fetch(`${baseUrl}/api/project`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sessionB.id, dir: dirB }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).dir, dirB);

      response = await fetch(`${baseUrl}/api/project?sessionId=${encodeURIComponent(sessionA.id)}`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).dir, dirA);

      response = await fetch(`${baseUrl}/api/project?sessionId=${encodeURIComponent(sessionB.id)}`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).dir, dirB);

      response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "opencode", prompt: "hello A", sessionId: sessionA.id }),
      });
      assert.equal(response.status, 200);
      await response.text();

      response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "opencode", prompt: "hello B", sessionId: sessionB.id }),
      });
      assert.equal(response.status, 200);
      await response.text();

      assert.deepEqual(cwds, [dirA, dirB]);
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
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "opencode", prompt: "@Gemini hello", projectDir: baseDir }),
      });
      await response.text();

      assert.equal(response.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].cwd, baseDir);
      assert.equal(calls[0].env.SHIFT_WORKTREE, "0");
      assert.equal(calls[0].env.SHIFT_BASE_DIR, baseDir);
      assert.equal(calls[0].env.SHIFT_WORKTREE_DIR, baseDir);
      assert.equal(calls[0].env.SHIFT_BRANCH, "");
    }
  );
});

test("chat endpoint creates and uses a session worktree as child cwd", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-worktree-base-"));
  const worktreeDir = path.join(os.tmpdir(), "server-worktree-session");
  const calls = [];
  const worktreeCalls = [];

  await withServer(
    {
      worktreeManager: {
        ensureWorktree({ baseDir: requestedBaseDir, sessionId }) {
          worktreeCalls.push({ requestedBaseDir, sessionId });
          return {
            sessionId,
            baseDir,
            worktreeDir,
            branch: `codex/session-${sessionId}`,
            status: "active",
            createdAt: "2026-06-30T00:00:00.000Z",
          };
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
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: "opencode",
          prompt: "@Gemini hello",
          projectDir: baseDir,
          useWorktree: true,
        }),
      });
      const text = await response.text();

      assert.equal(response.status, 200);
      const sessionId = text.match(/"sessionId":"([^"]+)"/)[1];
      assert.equal(worktreeCalls.length, 1);
      assert.equal(worktreeCalls[0].requestedBaseDir, baseDir);
      assert.equal(worktreeCalls[0].sessionId, sessionId);
      assert.equal(calls[0].cwd, worktreeDir);
      assert.equal(
        calls[0].args[0],
        path.resolve(__dirname, "..", "src", "agents", "invoke-cli.js")
      );
      assert.equal(calls[0].env.SHIFT_WORKTREE, "1");
      assert.equal(calls[0].env.SHIFT_WORKTREE_DIR, worktreeDir);
    }
  );
});

test("worktree A2A keeps Grok read-only until Codex approves its concrete plan", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-a2a-worktree-base-"));
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-a2a-worktree-session-"));
  const runs = [];
  let reviewedContent = "";
  let grokRuns = 0;
  const grokPlanOut = [
    "```implementation_plan",
    "summary: Add the review target file",
    "files:",
    "  - review-target.txt",
    "changes:",
    "  - Create the file with the requested content",
    "tests:",
    "  - Read the file from the shared worktree",
    "risks:",
    "  - Keep the change isolated",
    "```",
    "",
    "@Codex",
    "```handoff",
    "to: codex",
    "intent: discuss",
    "what: Concrete implementation plan is ready",
    "why: The plan needs lead approval before writes",
    "next_action: Review the plan and send an implement handoff if approved",
    "```",
  ].join("\n");
  const codexApprovalOut = [
    "```solution_baseline",
    `user_goal_hash: ${hashUserGoal("implement and request review")}`,
    "summary: Add the requested review target file",
    "constraints:",
    "  - Keep the change isolated",
    "non_goals:",
    "  - Do not modify unrelated files",
    "acceptance_criteria:",
    "  - OpenCode can read the implemented file",
    "```",
    "",
    "@Grok",
    "```handoff",
    "to: grok",
    "intent: implement",
    "what: Implement the submitted concrete plan",
    "why: The plan matches the converged solution",
    "next_action: Apply the approved plan and run its checks",
    "```",
  ].join("\n");
  const grokImplementationOut = [
    "@OpenCode",
    "",
    "```handoff",
    "to: opencode",
    "intent: review",
    "goal: Review the implementation",
    "what: Grok changed review-target.txt",
    "why: Verify the worktree diff",
    "tradeoff: none",
    "next_action: Read and review the changed file",
    "files:",
    "  - review-target.txt",
    "```",
  ].join("\n");

  await withServer(
    {
      worktreeManager: {
        ensureWorktree({ sessionId }) {
          return {
            sessionId,
            baseDir,
            worktreeDir,
            branch: `codex/session-${sessionId}`,
            status: "active",
            createdAt: "2026-08-04T00:00:00.000Z",
          };
        },
      },
      spawnRunner(_command, args, options) {
        const agent = args[2];
        runs.push({
          agent,
          cwd: options.cwd,
          runnerPath: args[0],
          env: options.env,
          prompt: args[3],
        });
        const child = createMockChild();
        process.nextTick(() => {
          if (agent === "grok") {
            grokRuns += 1;
            const isApproved = options.env.SHIFT_GROK_IMPLEMENTATION_GATE === "approved";
            if (isApproved) {
              fs.writeFileSync(path.join(options.cwd, "review-target.txt"), "changed by grok\n");
            }
            child.stdout.write(
              JSON.stringify({
                type: "text.delta",
                agent: "grok",
                invocationId: "worktree-grok",
                text: isApproved ? grokImplementationOut : grokPlanOut,
              }) + "\n"
            );
          } else if (agent === "codex") {
            child.stdout.write(
              JSON.stringify({
                type: "text.delta",
                agent: "codex",
                invocationId: "worktree-codex",
                text: codexApprovalOut,
              }) + "\n"
            );
          } else {
            reviewedContent = fs.readFileSync(
              path.join(options.cwd, "review-target.txt"),
              "utf8"
            );
            child.stdout.write(
              JSON.stringify({
                type: "text.delta",
                agent: "opencode",
                invocationId: "worktree-opencode",
                text: "reviewed",
              }) + "\n"
            );
          }
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: "grok",
          prompt: "implement and request review",
          projectDir: baseDir,
          useWorktree: true,
        }),
      });
      await response.text();

      assert.equal(response.status, 200);
      assert.deepEqual(
        runs.map(({ agent, cwd }) => ({ agent, cwd })),
        [
          { agent: "grok", cwd: worktreeDir },
          { agent: "codex", cwd: worktreeDir },
          { agent: "grok", cwd: worktreeDir },
          { agent: "opencode", cwd: worktreeDir },
        ]
      );
      assert.equal(reviewedContent, "changed by grok\n");
      assert.equal(grokRuns, 2);
      assert.equal(runs[0].env.SHIFT_GROK_IMPLEMENTATION_GATE, "required");
      assert.equal(runs[0].env.SHIFT_GROK_APPROVED_PLAN_HASH, "");
      assert.match(runs[0].prompt, /Grok 实现门禁/);
      assert.match(runs[0].prompt, /只读/);
      assert.equal(runs[2].env.SHIFT_GROK_IMPLEMENTATION_GATE, "approved");
      assert.match(runs[2].env.SHIFT_GROK_APPROVED_PLAN_HASH, /^[a-f0-9]{16}$/);
      assert.match(runs[2].prompt, /APPROVED/);
      assert.ok(runs.every((run) => path.isAbsolute(run.runnerPath)));
      assert.ok(runs.every((run) => run.runnerPath.startsWith(path.resolve(__dirname, ".."))));
    }
  );
});

test("PR4 workflow verifies OpenCode delivery before Codex accepts the original goal", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-pr4-base-"));
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-pr4-worktree-"));
  const userPrompt = "deliver with an audited pull request";
  const goalHash = hashUserGoal(userPrompt);
  const solution = {
    user_goal_hash: goalHash,
    summary: "Deliver the requested change through evidence-bound gates",
    constraints: ["Keep the five collaboration phases"],
    non_goals: ["Do not move code review to Codex"],
    acceptance_criteria: [
      "OpenCode creates a verified pull request",
      "Codex checks the original user goal",
    ],
  };
  const solutionHash = hashSolutionBaseline(solution);
  const implementationPlan = {
    summary: "Implement the audited delivery workflow",
    files: ["src/audited-delivery.js"],
    changes: ["Add the requested evidence-bound behavior"],
    tests: ["npm run verify:pr"],
    risks: ["Keep legacy routes compatible"],
  };
  const implementationPlanHash = hashImplementationPlan(implementationPlan);
  const commitSha = "a".repeat(40);
  const prUrl = "https://github.com/acme/repo/pull/7";
  const branch = "codex/session-pr4";
  const runs = [];
  let codexRuns = 0;
  let grokRuns = 0;

  function handoff(to, intent, what) {
    return [
      `@${to === "grok" ? "Grok" : to === "opencode" ? "OpenCode" : "Codex"}`,
      "```handoff",
      `to: ${to}`,
      `intent: ${intent}`,
      `what: ${what}`,
      "why: Follow the evidence-bound workflow",
      "next_action: Continue with the assigned workflow responsibility",
      "```",
    ].join("\n");
  }

  const codexBaselineOut = [
    "```solution_baseline",
    `user_goal_hash: ${goalHash}`,
    `summary: ${solution.summary}`,
    "constraints:",
    `  - ${solution.constraints[0]}`,
    "non_goals:",
    `  - ${solution.non_goals[0]}`,
    "acceptance_criteria:",
    ...solution.acceptance_criteria.map((item) => `  - ${item}`),
    "```",
    handoff("grok", "plan", "Inspect the code and propose a concrete plan"),
  ].join("\n\n");
  const grokPlanOut = [
    "```implementation_plan",
    `summary: ${implementationPlan.summary}`,
    "files:",
    `  - ${implementationPlan.files[0]}`,
    "changes:",
    `  - ${implementationPlan.changes[0]}`,
    "tests:",
    `  - ${implementationPlan.tests[0]}`,
    "risks:",
    `  - ${implementationPlan.risks[0]}`,
    "```",
    handoff("codex", "discuss", "Review the concrete implementation plan"),
  ].join("\n\n");
  const codexApprovalOut = handoff("grok", "implement", "Implement the approved plan");
  const grokImplementationOut = handoff(
    "opencode",
    "review",
    "Review the completed implementation and its verification"
  );
  const openCodeDeliveryOut = [
    "```code_review",
    "verdict: approve",
    "summary: No blocking findings",
    "findings:",
    "  - none",
    "tests:",
    "  - npm run verify:pr: passed",
    "```",
    "```delivery_receipt",
    `commit_sha: ${commitSha}`,
    `pr_url: ${prUrl}`,
    "base_branch: master",
    "verification:",
    "  - npm run verify:pr: passed",
    "  - GitHub checks: passed",
    "```",
    handoff("codex", "accept", "Perform final goal acceptance on the verified delivery"),
  ].join("\n\n");
  const codexFinalOut = [
    "```final_acceptance",
    "verdict: accept",
    `user_goal_hash: ${goalHash}`,
    `solution_hash: ${solutionHash}`,
    `implementation_plan_hash: ${implementationPlanHash}`,
    `commit_sha: ${commitSha}`,
    "checks:",
    "  - OpenCode creates a verified pull request => pass: PR #7 and green CI",
    "  - Codex checks the original user goal => pass: goal and solution hashes matched",
    "gaps:",
    "  - none",
    "```",
  ].join("\n");

  await withServer(
    {
      worktreeManager: {
        ensureWorktree({ sessionId }) {
          return {
            sessionId,
            baseDir,
            worktreeDir,
            branch,
            status: "active",
            createdAt: "2026-08-05T00:00:00.000Z",
          };
        },
      },
      deliveryVerifier: {
        verify({ receipt, cwd, branch: actualBranch }) {
          assert.equal(receipt.commit_sha, commitSha);
          assert.equal(cwd, worktreeDir);
          assert.equal(actualBranch, branch);
          return {
            verified: true,
            commitSha,
            commitSubject: "feat(collab): verify delivery evidence",
            commitBody: "Bind the reviewed commit to the pull request and CI evidence.",
            branch,
            baseBranch: "master",
            prUrl,
            prNumber: 7,
            prTitle: "Verify OpenCode delivery evidence",
            prBody: [
              "## Summary",
              "Goal",
              "## Changes",
              "Change",
              "## Verification",
              "Passed",
              "## Risks",
              "None",
            ].join("\n\n"),
            ciStatus: "success",
          };
        },
      },
      spawnRunner(_command, args, _options) {
        const agent = args[2];
        runs.push({ agent, prompt: args[3] });
        const child = createMockChild();
        process.nextTick(() => {
          let output = "";
          if (agent === "codex") {
            output = [codexBaselineOut, codexApprovalOut, codexFinalOut][codexRuns++];
          } else if (agent === "grok") {
            output = [grokPlanOut, grokImplementationOut][grokRuns++];
          } else {
            output = openCodeDeliveryOut;
          }
          child.stdout.write(
            JSON.stringify({
              type: "text.delta",
              agent,
              invocationId: `pr4-${agent}`,
              text: output,
            }) + "\n"
          );
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: "codex",
          prompt: userPrompt,
          projectDir: baseDir,
          useWorktree: true,
        }),
      });
      const text = await response.text();
      assert.equal(response.status, 200);
      assert.deepEqual(runs.map((run) => run.agent), [
        "codex",
        "grok",
        "codex",
        "grok",
        "opencode",
        "codex",
      ]);
      assert.match(runs[0].prompt, /solution_baseline/);
      assert.match(runs[4].prompt, /OpenCode Review 与交付门禁/);
      assert.match(runs[5].prompt, /final_acceptance/);
      assert.match(runs[5].prompt, /最初用户目标/);
      assert.match(text, /event: delivery-evidence-verified/);
      assert.match(text, /event: final-acceptance-submitted/);
      assert.match(text, /event: collaboration-done/);
    }
  );
});

test("chat endpoint reuses the session worktree on later turns", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-worktree-base-"));
  const worktreeDir = path.join(os.tmpdir(), "server-worktree-reuse");
  let ensureCount = 0;
  const cwds = [];

  await withServer(
    {
      worktreeManager: {
        ensureWorktree({ sessionId }) {
          ensureCount += 1;
          return {
            sessionId,
            baseDir,
            worktreeDir,
            branch: `codex/session-${sessionId}`,
            status: "active",
            createdAt: "2026-06-30T00:00:00.000Z",
          };
        },
      },
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
      const created = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
      const { session } = await created.json();

      for (const prompt of ["first", "second"]) {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent: "opencode",
            prompt,
            sessionId: session.id,
            projectDir: baseDir,
            useWorktree: true,
          }),
        });
        assert.equal(response.status, 200);
        await response.text();
      }

      assert.equal(ensureCount, 1);
      assert.deepEqual(cwds, [worktreeDir, worktreeDir]);
    }
  );
});

test("chat endpoint treats useWorktree as a per-run permission gate after a worktree already exists", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-worktree-toggle-"));
  const worktreeDir = path.join(os.tmpdir(), "server-worktree-toggle-session");
  const runs = [];

  await withServer(
    {
      worktreeManager: {
        ensureWorktree({ sessionId }) {
          return {
            sessionId,
            baseDir,
            worktreeDir,
            branch: `codex/session-${sessionId}`,
            status: "active",
            createdAt: "2026-06-30T00:00:00.000Z",
          };
        },
      },
      spawnRunner(command, args, options) {
        runs.push({ cwd: options.cwd, env: options.env });
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write("ok");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const created = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
      const { session } = await created.json();

      const first = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: "opencode",
          prompt: "first",
          sessionId: session.id,
          projectDir: baseDir,
          useWorktree: true,
        }),
      });
      assert.equal(first.status, 200);
      await first.text();

      const second = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: "opencode",
          prompt: "second",
          sessionId: session.id,
          projectDir: baseDir,
          useWorktree: false,
        }),
      });
      assert.equal(second.status, 200);
      await second.text();

      assert.equal(runs.length, 2);
      assert.equal(runs[0].cwd, worktreeDir);
      assert.equal(runs[0].env.SHIFT_WORKTREE, "1");
      assert.equal(runs[0].env.SHIFT_WORKTREE_DIR, worktreeDir);

      assert.equal(runs[1].cwd, baseDir);
      assert.equal(runs[1].env.SHIFT_WORKTREE, "0");
      assert.equal(runs[1].env.SHIFT_WORKTREE_DIR, baseDir);
      assert.equal(runs[1].env.SHIFT_BRANCH, "");
    }
  );
});

test("chat ignores legacy session maps when switching into worktree mode", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-worktree-resume-"));
  const sessionsFile = path.join(tmpDir, "sessions.json");
  const memoryDbFile = path.join(tmpDir, "shift.sqlite");
  const invocationsFile = path.join(tmpDir, "invocations.json");
  const sessionMapRoot = path.join(tmpDir, "session-maps");
  const transcriptsDir = path.join(tmpDir, "transcripts");
  const prevTranscriptDir = process.env.SHIFT_TRANSCRIPT_DIR;
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-worktree-resume-base-"));
  const worktreeDir = path.join(os.tmpdir(), "server-worktree-resume-session");
  const runs = [];

  if (!prevTranscriptDir) process.env.SHIFT_TRANSCRIPT_DIR = transcriptsDir;
  prepareCleanEpoch({ file: memoryDbFile });

  const server = createServer({
    uiToken: TEST_UI_TOKEN,
    sessionsFile,
    memoryDbFile,
    invocationsFile,
    sessionMapRoot,
    storageMode: "sqlite",
    worktreeManager: {
      ensureWorktree({ sessionId }) {
        return {
          sessionId,
          baseDir,
          worktreeDir,
          branch: `codex/session-${sessionId}`,
          status: "active",
          createdAt: "2026-07-02T00:00:00.000Z",
        };
      },
    },
    spawnRunner(command, args, options) {
      runs.push({ cwd: options.cwd, env: options.env, args });
      const child = createMockChild();
      process.nextTick(() => {
        child.stdout.end();
        child.emit("close", 0, null);
      });
      return child;
    },
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const created = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
    const { session } = await created.json();

    const sessionMapDir = path.join(sessionMapRoot, session.id);
    fs.mkdirSync(sessionMapDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionMapDir, "sessions.json"),
      JSON.stringify(
        {
          opencode: {
            sessionId: "readonly-session-1",
            workspaceKey: `base:${baseDir}`,
            updatedAt: "2026-07-02T00:00:00.000Z",
          },
        },
        null,
        2
      )
    );

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "opencode",
        prompt: "switch to worktree",
        sessionId: session.id,
        projectDir: baseDir,
        useWorktree: true,
      }),
    });
    assert.equal(response.status, 200);
    await response.text();

    assert.equal(runs.length, 1);
    assert.equal(runs[0].cwd, worktreeDir);
    assert.equal(runs[0].env.INVOKE_SESSION_ID, "");
    assert.equal(runs[0].env.INVOKE_WORKSPACE_KEY, `worktree:${worktreeDir}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await server.closeStorageContext?.();
    if (!prevTranscriptDir) {
      delete process.env.SHIFT_TRANSCRIPT_DIR;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("chat endpoint resumes the matching provider session after base↔worktree round-trip", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-workspace-roundtrip-"));
  const sessionsFile = path.join(tmpDir, "sessions.json");
  const memoryDbFile = path.join(tmpDir, "shift.sqlite");
  const transcriptsDir = path.join(tmpDir, "transcripts");
  const prevTranscriptDir = process.env.SHIFT_TRANSCRIPT_DIR;
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-workspace-roundtrip-base-"));
  const worktreeDir = path.join(os.tmpdir(), "server-workspace-roundtrip-wt");
  const runs = [];

  if (!prevTranscriptDir) process.env.SHIFT_TRANSCRIPT_DIR = transcriptsDir;
  prepareCleanEpoch({ file: memoryDbFile });

  const server = createServer({
    uiToken: TEST_UI_TOKEN,
    sessionsFile,
    memoryDbFile,
    storageMode: "sqlite",
    worktreeManager: {
      ensureWorktree({ sessionId }) {
        return {
          sessionId,
          baseDir,
          worktreeDir,
          branch: `codex/session-${sessionId}`,
          status: "active",
          createdAt: "2026-07-02T00:00:00.000Z",
        };
      },
    },
    spawnRunner(command, args, options) {
      runs.push({ cwd: options.cwd, env: options.env, args });
      const child = createMockChild();
      const providerSessionId =
        runs.length === 1
          ? "provider-base-1"
          : runs.length === 2
            ? "provider-wt-1"
            : `provider-later-${runs.length}`;
      process.nextTick(() => {
        child.stdout.write(
          `${JSON.stringify({ type: "run.started", sessionId: providerSessionId })}\n`
        );
        child.stdout.end();
        child.emit("close", 0, null);
      });
      return child;
    },
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const created = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
    const { session } = await created.json();

    const initialBaseChat = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify({
        agent: "opencode",
        prompt: "initial base turn",
        sessionId: session.id,
        projectDir: baseDir,
        useWorktree: false,
      }),
    });
    await initialBaseChat.text();

    const worktreeChat = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "opencode",
        prompt: "worktree turn",
        sessionId: session.id,
        projectDir: baseDir,
        useWorktree: true,
      }),
    });
    assert.equal(worktreeChat.status, 200);
    await worktreeChat.text();

    const resumedWorktreeChat = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify({
        agent: "opencode",
        prompt: "worktree turn again",
        sessionId: session.id,
        projectDir: baseDir,
        useWorktree: true,
      }),
    });
    await resumedWorktreeChat.text();

    const baseChat = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "opencode",
        prompt: "base turn again",
        sessionId: session.id,
        projectDir: baseDir,
        useWorktree: false,
      }),
    });
    assert.equal(baseChat.status, 200);
    await baseChat.text();

    assert.equal(runs.length, 4);
    assert.equal(runs[0].env.INVOKE_SESSION_ID, "");
    assert.equal(runs[1].env.INVOKE_SESSION_ID, "");
    assert.equal(runs[2].cwd, worktreeDir);
    assert.equal(runs[2].env.INVOKE_SESSION_ID, "provider-wt-1");
    assert.equal(runs[2].env.INVOKE_WORKSPACE_KEY, `worktree:${worktreeDir}`);
    assert.equal(runs[3].cwd, baseDir);
    assert.equal(runs[3].env.INVOKE_SESSION_ID, "provider-base-1");
    assert.equal(runs[3].env.INVOKE_WORKSPACE_KEY, `base:${baseDir}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await server.closeStorageContext?.();
    if (!prevTranscriptDir) {
      delete process.env.SHIFT_TRANSCRIPT_DIR;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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
      const created = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
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
      const created = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
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

test("chat endpoint aborts previous invocation on same session", async () => {
  let callCount = 0;
  await withServer(
    {
      spawnRunner(_command, _args) {
        callCount += 1;
        const child = createMockChild();
        if (callCount === 1) {
          // Hold the first child open until it is killed by the second chat.
          child.kill = (sig) => {
            child.stderr.write(`killed:${sig}\n`);
            child.emit("close", null, sig);
            return true;
          };
        } else {
          // Second child finishes quickly so the test can complete.
          process.nextTick(() => {
            child.stdout.write("done");
            child.emit("close", 0, null);
          });
        }
        return child;
      },
    },
    async (baseUrl, { memoryDbFile }) => {
      // Create a session explicitly so both chats target the same id.
      const created = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
      const { session } = await created.json();

      // Start first long-running chat.
      const first = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: "codex",
          prompt: "long task",
          sessionId: session.id,
          clientTurnId: "turn-old",
        }),
      });
      assert.equal(first.status, 200);

      // Start second chat on the same session: it should abort the first.
      const second = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: "opencode",
          prompt: "new task",
          sessionId: session.id,
          clientTurnId: "turn-new",
        }),
      });
      assert.equal(second.status, 200);

      const text = await second.text();
      const startMatch = text.match(
        /event: agent-start\ndata: \{"agent":"opencode","invocationId":"([^"]+)"\}/
      );
      assert.ok(startMatch, "agent-start must retain its stable two-field payload");
      const windowMeta = text
        .split("\n\n")
        .find(
          (frame) =>
            frame.startsWith("event: window-meta\n") &&
            frame.includes(`"invocationId":"${startMatch[1]}"`)
        );
      assert.ok(windowMeta, "window-meta must correlate by invocationId");
      assert.match(windowMeta, /"parentInvocationId":null/);
      assert.match(windowMeta, /"triggerMessageId":"[^"]+"/);
      assert.match(windowMeta, /"triggerType":"user-message"/);
      assert.equal(callCount, 2);

      const firstText = await first.text();
      const firstInvocationId = firstText.match(
        /event: agent-start\ndata: \{"agent":"codex","invocationId":"([^"]+)"\}/
      )?.[1];
      assert.ok(firstInvocationId);
      const storage = createStorage({ file: memoryDbFile });
      try {
        assert.equal(storage.invocations.get(firstInvocationId).state, "aborted");
        const ended = storage.invocations
          .listEvents(firstInvocationId)
          .find((event) => event.kind === "invocation-end");
        assert.equal(ended.payload.supersededByClientTurnId, "turn-new");
      } finally {
        storage.close();
      }
    }
  );
});

test("stale aborted chat cleanup does not unregister the replacement chat callbacks", async () => {
  const spawned = [];

  await withServer(
    {
      spawnRunner(command, args, options = {}) {
        const child = createMockChild();
        child.env = options.env;
        child.closeNow = (code = 0, sig = null) => child.emit("close", code, sig);
        child.kill = (sig) => {
          child.killedWith = sig;
          return true;
        };
        spawned.push(child);
        return child;
      },
    },
    async (baseUrl) => {
      const created = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
      const { session } = await created.json();

      const firstPromise = fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "codex", prompt: "old task", sessionId: session.id }),
      }).then((r) => r.text());

      const deadline1 = Date.now() + 2000;
      while (spawned.length < 1 && Date.now() < deadline1) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(spawned.length, 1);

      const secondPromise = fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: "opencode",
          prompt: "replacement task",
          sessionId: session.id,
        }),
      }).then((r) => r.text());

      const deadline2 = Date.now() + 2000;
      while (spawned.length < 2 && Date.now() < deadline2) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(spawned.length, 2);
      assert.equal(spawned[0].killedWith, "SIGTERM");

      try {
        // The stale first request closes after the replacement request has
        // registered its callback thread. Its cleanup must not delete the
        // replacement thread/token.
        spawned[0].closeNow(null, "SIGTERM");
        await Promise.race([
          firstPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("first chat did not close")), 2000)
          ),
        ]);

        const env = spawned[1].env;
        const callbackResp = await fetch(
          `${baseUrl}/api/callbacks/thread-context?` +
            `sessionId=${encodeURIComponent(session.id)}&` +
            `invocationId=${encodeURIComponent(env.SHIFT_INVOCATION_ID)}`,
          { headers: { "X-Callback-Token": env.SHIFT_CALLBACK_TOKEN } }
        );
        assert.equal(callbackResp.status, 200);
      } finally {
        spawned[1].stdout.write("done");
        spawned[1].closeNow(0, null);
        await secondPromise.catch(() => {});
      }
    }
  );
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
  };

  const invocationId = "invocation-cb-1";
  const callbackToken = "token-cb-1";
  threadCtx.tokens.set(invocationId, { agentId: "codex", callbackToken });
  callbacks.registerThread(sessionId, threadCtx);

  const appended = [];
  const appendFn = (sid, msg) => appended.push({ sid, msg });

  const ok = callbacks.postMessage(sessionId, invocationId, "@Gemini 请继续实现", {
    appendToSession: appendFn,
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
  });
  assert.equal(ok2.handoff.status, "skipped");
  assert.deepEqual(worklist, ["codex", "gemini"]);
  assert.equal(threadCtx.a2aCount, 1);

  callbacks.unregisterThread(sessionId);
});

test("Grok callback persists a concrete plan before routing it for Codex approval", () => {
  const sessionId = "session-cb-grok-plan";
  const invocationId = "invocation-cb-grok-plan";
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
    worklist: ["grok"],
    controller: new AbortController(),
    a2aCount: 0,
    useWorktree: true,
    collabTaskRegistry: registry,
    tokens: new Map([[invocationId, { agentId: "grok", callbackToken: "token" }]]),
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
    tokens: new Map([[invocationId, { agentId: "codex", callbackToken }]]),
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
    sessionsFile: "/tmp/sessions.json",
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
    sessionsFile: "/tmp/sessions.json",
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
    sessionsFile: "/tmp/sessions.json",
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

test("validateToken accepts non-expiring legacy tokens (backward compat)", () => {
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
    sessionsFile: "/tmp/sessions.json",
    tokens: new Map([[invocationId, { agentId: "codex", callbackToken }]]), // no expiresAt
  };
  callbacks.registerThread(sessionId, threadCtx);

  assert.equal(callbacks.validateToken(sessionId, invocationId, callbackToken), true);

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
        const response = await fetch(`${baseUrl}/api/chat`, {
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
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent: "codex", prompt: "start" }),
        });
        const text = await response.text();
        // Seal lifecycle: pre-call rotate and/or post/physical seal — never silent drop.
        assert.match(text, /event: sealed\ndata: \{[^\n]*"agent":"codex"/);
        assert.match(
          text,
          /"reason":"(context overflow|pre-call-projected|physical-ceiling|post-turn-[^"]+|physical-ceiling-empty)"/
        );
        // User still gets non-empty assistant text (or explicit retryable error).
        assert.ok(
          /"role":"assistant","text":"x{10,}/.test(text) || /retryable":true/.test(text),
          "expected non-empty assistant stream or retryable error after seal pressure"
        );
      }
    );
  } finally {
    if (prevCapacity === undefined) delete process.env.SHIFT_TEST_CAPACITY;
    else process.env.SHIFT_TEST_CAPACITY = prevCapacity;
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

        // Fire the chat in background; the mock holds the child open so we can
        // poke the callback endpoints while it's "running".
        const chatPromise = fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent: "opencode",
            prompt: "long running task about redis clustering",
            sessionId: knownSessionId,
          }),
        });

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

test("/api/callbacks/session-search rejects without X-Callback-Token", async () => {
  await withServer({}, async (baseUrl) => {
    const resp = await fetch(
      `${baseUrl}/api/callbacks/session-search?sessionId=x&invocationId=y&query=z`
    );
    assert.equal(resp.status, 400);
  });
});

test("/api/callbacks/session-search rejects invalid token with 401", async () => {
  await withServer({}, async (baseUrl) => {
    const resp = await fetch(
      `${baseUrl}/api/callbacks/session-search?sessionId=x&invocationId=y&query=z`,
      { headers: { "X-Callback-Token": "wrong" } }
    );
    assert.equal(resp.status, 401);
  });
});

test("/api/callbacks/session-search empty query returns recency payload shape", async () => {
  await withActiveChat(async (baseUrl, sid, captured) => {
    const resp = await fetch(
      `${baseUrl}/api/callbacks/session-search?sessionId=${sid}&invocationId=${captured.env.SHIFT_INVOCATION_ID}`,
      { headers: { "X-Callback-Token": captured.env.SHIFT_CALLBACK_TOKEN } }
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.ok(Array.isArray(body.hits));
    assert.ok(body.layers);
    assert.equal(typeof body.layers.memory, "number");
    assert.equal(typeof body.truncated, "boolean");
  });
});

test("/api/callbacks/session-search returns hits during active chat", async () => {
  await withActiveChat(async (baseUrl, sid, captured) => {
    const invId = captured.env.SHIFT_INVOCATION_ID;
    const token = captured.env.SHIFT_CALLBACK_TOKEN;

    // Give the user-prompt transcript event time to flush
    await new Promise((r) => setTimeout(r, 200));

    const resp = await fetch(
      `${baseUrl}/api/callbacks/session-search?` +
        `sessionId=${encodeURIComponent(sid)}&` +
        `invocationId=${encodeURIComponent(invId)}&` +
        `query=${encodeURIComponent("redis clustering")}&` +
        `limit=10`,
      { headers: { "X-Callback-Token": token } }
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.query, "redis clustering");
    assert.equal(body.limit, 10);
    assert.ok(body.hits.length >= 1, `expected at least one hit, got ${JSON.stringify(body.hits)}`);
    assert.match(body.hits[0].snippet, /redis clustering/);
    assert.ok(body.layers);
    assert.ok(typeof body.hits[0].layer === "string");
    assert.ok(typeof body.hits[0].score === "number");
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
        query: "previous decision",
      }),
    });
    assert.equal(resp.status, 401);
  });
});

test("/api/callbacks/session-search caps limit at 200", async () => {
  await withActiveChat(async (baseUrl, sid, captured) => {
    const resp = await fetch(
      `${baseUrl}/api/callbacks/session-search?` +
        `sessionId=${encodeURIComponent(sid)}&` +
        `invocationId=${encodeURIComponent(captured.env.SHIFT_INVOCATION_ID)}&` +
        `query=redis&limit=99999`,
      { headers: { "X-Callback-Token": captured.env.SHIFT_CALLBACK_TOKEN } }
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.ok(body.limit <= 200, `limit should be capped at 200, got ${body.limit}`);
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
    assert.equal(active.agent, "opencode");
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

test("buildCallbackInstructions mentions recall and memory-write commands", () => {
  const tpl = callbacks.buildCallbackInstructions("http://127.0.0.1:8787");
  assert.match(tpl, /recall_search/);
  assert.match(tpl, /callback-client\.js list-invocations/);
  assert.match(tpl, /callback-client\.js session-search/);
  assert.match(tpl, /callback-client\.js read-invocation/);
  assert.match(tpl, /callback-client\.js memory-upsert/);
  assert.match(tpl, /memory_write/);
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
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent: "gemini",
            prompt: "hello world",
            sessionId: "bootstrap-test-session",
          }),
        });
        await response.text();
      }
    );

    assert.ok(capturedPrompt, "spawnRunner should have been called");
    // Agent persona identity (from identities/*.md) comes first
    assert.match(capturedPrompt, /<!-- Agent Identity: gemini \/ Gemini -->/);
    assert.match(capturedPrompt, /<!-- \/Agent Identity -->/);
    // Session coords section
    assert.match(capturedPrompt, /<!-- Session Identity -->/);
    assert.match(capturedPrompt, /Thread: bootstrap-test-session/);
    assert.match(capturedPrompt, /Session: bootstrap-test-session/);
    assert.match(capturedPrompt, /Agent: Gemini/);
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

test("A2A-routed agents get persona identity + light session header, not full bootstrap", async () => {
  const prompts = [];

  await withServer(
    {
      initialSessionIds: ["bootstrap-a2a-test"],
      spawnRunner(command, args) {
        prompts.push(args[args.length - 1]);
        const child = createMockChild();
        process.nextTick(() => {
          if (args[2] === "codex") {
            child.stdout.write(
              JSON.stringify({
                type: "text.delta",
                agent: "codex",
                invocationId: "bootstrap-a2a-1",
                text: "@Gemini\nhandoff please\ncodex result",
              }) + "\n"
            );
          } else {
            child.stdout.write(
              JSON.stringify({
                type: "text.delta",
                agent: "gemini",
                invocationId: "bootstrap-a2a-2",
                text: "gemini received",
              }) + "\n"
            );
          }
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: "codex",
          prompt: "start",
          sessionId: "bootstrap-a2a-test",
        }),
      });
      await response.text();
    }
  );

  assert.equal(prompts.length, 2);
  // First agent: full bootstrap (session + digest + recall) + its persona
  assert.match(prompts[0], /<!-- Agent Identity: codex \/ Codex -->/);
  assert.match(prompts[0], /<!-- Session Identity -->/);
  assert.match(prompts[0], /<!-- 回忆铁律/);
  assert.match(prompts[0], /<!-- Digest/);
  // A2A agent: own persona + light session header + handoff, but no full digest/recall pack
  assert.match(prompts[1], /<!-- Agent Identity: gemini \/ Gemini -->/);
  assert.match(prompts[1], /<!-- Session Identity -->/);
  assert.match(prompts[1], /Agent: Gemini/);
  assert.doesNotMatch(prompts[1], /<!-- 回忆铁律/);
  assert.doesNotMatch(prompts[1], /<!-- Digest/);
  // Wave R: A2A turns get compact Active Memory Card, not the full bootstrap packet.
  assert.match(prompts[1], /<!-- Active Memories/);
  assert.match(prompts[1], /任务交接/);
  assert.match(prompts[1], /codex result/);
  // No ```handoff block → soft degraded path still routes with warning
  assert.match(prompts[1], /未提供标准/);
});

test("A2A-routed agents receive structured handoff fields when present", async () => {
  const prompts = [];
  const codexOut = [
    "@Gemini",
    "",
    "```handoff",
    "to: gemini",
    "goal: 拆解登录方案",
    "what: 用户要登录功能",
    "why: 需要无状态鉴权支持多实例",
    "tradeoff: 暂不做 OAuth",
    "next_action: 给出 JWT vs Session 对比与推荐",
    "files:",
    "  - docs/auth.md",
    "```",
    "",
    "codex narrative",
  ].join("\n");

  await withServer(
    {
      initialSessionIds: ["structured-handoff-test"],
      spawnRunner(command, args) {
        prompts.push(args[args.length - 1]);
        const child = createMockChild();
        process.nextTick(() => {
          if (args[2] === "codex") {
            child.stdout.write(
              JSON.stringify({
                type: "text.delta",
                agent: "codex",
                invocationId: "sh-1",
                text: codexOut,
              }) + "\n"
            );
          } else {
            child.stdout.write(
              JSON.stringify({
                type: "text.delta",
                agent: "opencode",
                invocationId: "sh-2",
                text: "planned",
              }) + "\n"
            );
          }
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: "codex",
          prompt: "做登录",
          sessionId: "structured-handoff-test",
        }),
      });
      await response.text();
    }
  );

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Structured Handoff/);
  assert.match(prompts[1], /what: 用户要登录功能/);
  assert.match(prompts[1], /why: 需要无状态鉴权支持多实例/);
  assert.match(prompts[1], /next_action: 给出 JWT vs Session 对比与推荐/);
  assert.match(prompts[1], /交接包完整度: ok/);
  assert.match(prompts[1], /做登录/);
  assert.doesNotMatch(prompts[1], /未提供标准/);
  // A2A follow-up gets compact card (not full always-on a2a-handoff skill body).
  assert.match(prompts[1], /A2A Handoff Card/);
  assert.doesNotMatch(prompts[1], /APPLICATION SKILL: a2a-handoff/);
});

test("A2A allows the same agent to re-enter worklist (review → fix)", async () => {
  const prompts = [];
  const agentsSeen = [];
  const grokOut1 = [
    "@OpenCode",
    "",
    "```handoff",
    "to: opencode",
    "what: 实现了登录",
    "why: 需要鉴权",
    "next_action: 请 review",
    "```",
  ].join("\n");
  const openCodeOut = [
    "@Grok",
    "",
    "```handoff",
    "to: grok",
    "what: |",
    "  结论: request-changes",
    "  P0: 缺空指针检查",
    "why: 可崩溃",
    "next_action: 修 P0 后回审",
    "```",
  ].join("\n");

  await withServer(
    {
      initialSessionIds: ["reentry-handoff-test"],
      spawnRunner(command, args) {
        const agent = args[2];
        agentsSeen.push(agent);
        prompts.push(args[args.length - 1]);
        const child = createMockChild();
        process.nextTick(() => {
          let text = "done";
          if (agent === "grok" && agentsSeen.filter((a) => a === "grok").length === 1) {
            text = grokOut1;
          } else if (agent === "opencode") {
            text = openCodeOut;
          } else if (agent === "grok") {
            text = "fixed p0";
          }
          child.stdout.write(
            JSON.stringify({
              type: "text.delta",
              agent,
              invocationId: `reentry-${agentsSeen.length}`,
              text,
            }) + "\n"
          );
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: "grok",
          prompt: "做登录并走 review",
          sessionId: "reentry-handoff-test",
        }),
      });
      const text = await response.text();
      assert.equal(response.status, 200);
      assert.deepEqual(agentsSeen, ["grok", "opencode", "grok"]);
      assert.equal(prompts.length, 3);
      assert.match(text, /event: a2a-route\ndata: \{[^\n]*"from":"grok"[^\n]*"to":"opencode"/);
      assert.match(text, /event: a2a-route\ndata: \{[^\n]*"from":"opencode"[^\n]*"to":"grok"/);
      assert.match(text, /"reentry":true/);
      // Second Grok turn: structured handoff + compact card + receiving-review.
      assert.match(prompts[2], /任务交接/);
      assert.match(prompts[2], /request-changes|缺空指针/);
      assert.match(prompts[2], /A2A Handoff Card/);
      assert.match(prompts[2], /APPLICATION SKILL: receiving-review/);
      assert.doesNotMatch(prompts[2], /APPLICATION SKILL: a2a-handoff/);
      assert.match(prompts[2], /<!-- Agent Identity: grok/);
    }
  );
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
        await (
          await fetch(`${baseUrl}/api/chat`, {
            method: "POST",
            body: JSON.stringify({ agent: "opencode", prompt, sessionId }),
          })
        ).text();
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
  assert.match(instructions, /callback-client\.js session-search/);
  assert.match(instructions, /callback-client\.js read-invocation/);
  assert.match(instructions, /callback-client\.js memory-upsert/);
  assert.match(instructions, /layer=memory/);
  assert.match(instructions, /Active Memories/);
  assert.match(instructions, /--layers memory,message,evidence/);
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
              agent: "opencode",
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
      const chat = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "opencode", prompt: "remember this" }),
      });
      const chatText = await chat.text();
      const sidMatch = chatText.match(/event: session\ndata: \{"sessionId":"([^"]+)"\}/);
      assert.ok(sidMatch, "expected session event");
      const sid = sidMatch[1];
      const invMatch = chatText.match(
        /event: agent-start\ndata: \{"agent":"opencode","invocationId":"([^"]+)"\}/
      );
      assert.ok(invMatch, "expected agent-start with invocationId");
      const invId = invMatch[1];

      const listRes = await fetch(`${baseUrl}/api/callbacks/list-invocations?sessionId=${sid}`);
      const list = await listRes.json();
      assert.equal(listRes.status, 200);
      assert.equal(list.invocations.length, 1);
      assert.equal(list.invocations[0].invocationId, invId);
      assert.equal(list.invocations[0].agent, "opencode");
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

      const searchRes = await fetch(
        `${baseUrl}/api/callbacks/session-search?sessionId=${sid}&query=hello%20recall`
      );
      const search = await searchRes.json();
      assert.equal(searchRes.status, 200);
      assert.ok(search.hits.length >= 1);
      assert.equal(search.hits[0].invocationId, invId);

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

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createServer, ensureSession } = require("../src/server/index");
const { parseA2AMentions } = require("../src/agents/routing");
const callbacks = require("../src/agents/callbacks");

const TEST_UI_TOKEN = "test-ui-token";
const nativeFetch = globalThis.fetch.bind(globalThis);

/** Resolve @import-based public/styles.css aggregator for contract tests. */
function readFrontendCss() {
  const root = path.join(__dirname, "../public");
  const main = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  if (!main.includes("@import")) return main;
  return main.replace(/@import url\("\.\/styles\/([^"]+)"\);/g, (_, name) =>
    fs.readFileSync(path.join(root, "styles", name), "utf8")
  );
}

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
  const initialSessionIds = Array.isArray(options.initialSessionIds) ? options.initialSessionIds : [];
  const serverOptions = { ...options };
  delete serverOptions.initialSessionIds;
  for (const sessionId of initialSessionIds) ensureSession(sessionsFile, sessionId);
  const prevTranscriptDir = process.env.SHIFT_TRANSCRIPT_DIR;
  if (!prevTranscriptDir) {
    process.env.SHIFT_TRANSCRIPT_DIR = path.join(tmpDir, "transcripts");
  }
  const server = createServer({
    sessionsFile,
    memoryDbFile: path.join(tmpDir, "memory.sqlite"),
    worktreeManager: options.worktreeManager || createPassthroughWorktreeManager(),
    invocationsFile: path.join(tmpDir, "invocations.json"),
    sessionMapRoot: path.join(tmpDir, "session-maps"),
    uiToken: TEST_UI_TOKEN,
    ...serverOptions,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
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
    assert.deepEqual(body.agents.map((agent) => agent.id), ["codex", "gemini", "grok", "opencode"]);
    // Every agent must surface a non-empty description so the UI can show it.
    for (const agent of body.agents) {
      assert.ok(agent.description && agent.description.length > 0, `Agent ${agent.id} missing description`);
      // Identity pack metadata (role / duties) comes from src/agents/identities/*.md
      assert.ok(agent.role && agent.role.length > 0, `Agent ${agent.id} missing role`);
      assert.ok(Array.isArray(agent.duties) && agent.duties.length > 0, `Agent ${agent.id} missing duties`);
      assert.ok(Array.isArray(agent.boundaries), `Agent ${agent.id} missing boundaries array`);
    }
  });
});

test("top-level request errors return 500 without stopping the server", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "invoke-server-error-test-"));
  const blocker = path.join(dir, "not-a-directory");
  fs.writeFileSync(blocker, "block\n", "utf8");
  try {
    await withServer(
      {
        sessionsFile: path.join(blocker, "sessions.json"),
        logger: { error() {}, warn() {}, log() {} },
      },
      async (baseUrl) => {
        const failed = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
        assert.equal(failed.status, 500);
        assert.deepEqual(await failed.json(), { error: "Internal server error." });

        const healthy = await fetch(`${baseUrl}/api/agents`);
        assert.equal(healthy.status, 200);
      }
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("index injects the per-process UI token and loads the authenticated API client", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await nativeFetch(`${baseUrl}/`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, new RegExp(`name="shift-ui-token" content="${TEST_UI_TOKEN}"`));
    assert.doesNotMatch(html, /__SHIFT_UI_TOKEN__/);
    assert.match(html, /src="\/public\/boot\.js"/);
    const boot = require("../public/boot.js");
    assert.ok(boot.MODULES.includes("/public/api-client.js"));
  });
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
  await withServer({
    spawnRunner() {
      spawnCount += 1;
      return createMockChild();
    },
  }, async (baseUrl) => {
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
  });
});

test("chat rejects unsafe and unknown client-supplied session IDs", async () => {
  let spawnCount = 0;
  await withServer({
    spawnRunner() {
      spawnCount += 1;
      return createMockChild();
    },
  }, async (baseUrl) => {
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
  });
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
      assert.equal(calls[0].args[0], "src/agents/invoke-cli.js");
      assert.equal(calls[0].args[1], "--agent");
      assert.equal(calls[0].args[2], "opencode");
      assert.ok(calls[0].args[3].endsWith("hello"), `Expected last arg to end with "hello", got: ${calls[0].args[3]?.slice(-50)}`);
      assert.ok(calls[0].args[3].includes("APPLICATION SKILL"), "Expected augmented prompt to contain APPLICATION SKILL marker");
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
          child.stdout.write(JSON.stringify({ type: "text.delta", agent: "opencode", invocationId: "inv-test", text: "partial " }) + "\n");
          child.stdout.write(JSON.stringify({ type: "text.delta", agent: "opencode", invocationId: "inv-test", text: "answer" }) + "\n");
          child.stdout.write(JSON.stringify({
            type: "usage.update",
            agent: "opencode",
            invocationId: "inv-test",
            provider: "opencode",
            scope: "step",
            mode: "delta",
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
          }) + "\n");
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
      assert.equal(calls[0].args[0], "src/agents/invoke-cli.js");
      assert.equal(calls[0].args[1], "--agent");
      assert.equal(calls[0].args[2], "opencode");
      assert.ok(calls[0].args[3].includes("hello"), `Expected prompt to contain "hello", got: ${calls[0].args[3]?.slice(-50)}`);
      assert.ok(calls[0].args[3].includes("APPLICATION SKILL"), "Expected augmented prompt to contain APPLICATION SKILL marker");
      assert.ok(calls[0].args[3].includes("MCP 回调工具说明"), "Expected prompt to contain callback instructions");
      // Soft collab rules must be present on the first (non-A2A) turn.
      assert.match(calls[0].args[3], /<!-- Collaboration Rules -->/);
      assert.match(text, /event: message\ndata: \{"agent":"opencode","role":"assistant","text":"partial "\}/);
      assert.match(text, /event: message\ndata: \{"agent":"opencode","role":"assistant","text":"answer"\}/);
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
          child.stdout.write(JSON.stringify({
            type: "run.started",
            agent: "opencode",
            invocationId: "inv-1",
            provider: "opencode",
          }) + "\n");
          child.stdout.write(JSON.stringify({
            type: "text.delta",
            agent: "opencode",
            invocationId: "inv-1",
            text: "hello ",
          }) + "\n");
          child.stdout.write(JSON.stringify({
            type: "progress.update",
            agent: "opencode",
            invocationId: "inv-1",
            items: [{ text: "done", done: true }],
          }) + "\n");
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
          child.stdout.write(JSON.stringify({
            type: "run.started",
            agent: "opencode",
            invocationId: "inv-2",
            provider: "opencode",
          }) + "\n");
          child.stdout.write(JSON.stringify({
            type: "thinking.delta",
            agent: "opencode",
            invocationId: "inv-2",
            text: "inspect",
          }) + "\n");
          child.stdout.write(JSON.stringify({
            type: "text.delta",
            agent: "opencode",
            invocationId: "inv-2",
            text: "final answer",
          }) + "\n");
          child.stdout.write(JSON.stringify({
            type: "run.finished",
            agent: "opencode",
            invocationId: "inv-2",
            exitCode: 0,
            signal: null,
          }) + "\n");
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
          child.stdout.write(JSON.stringify({ type: "text.delta", agent: "opencode", invocationId: "inv-chunks", text: "line 1\n\n" }) + "\n");
          child.stdout.write(JSON.stringify({ type: "text.delta", agent: "opencode", invocationId: "inv-chunks", text: "    code-ish indent\n" }) + "\n");
          child.stdout.write(JSON.stringify({ type: "text.delta", agent: "opencode", invocationId: "inv-chunks", text: "- list item" }) + "\n");
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

      assert.match(text, /event: message\ndata: \{"agent":"opencode","role":"assistant","text":"line 1\\n\\n"\}/);
      assert.match(text, /event: message\ndata: \{"agent":"opencode","role":"assistant","text":" {4}code-ish indent\\n"\}/);
      assert.match(text, /event: message\ndata: \{"agent":"opencode","role":"assistant","text":"- list item"\}/);
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
          child.stderr.write("2026-06-28T13:52:47.421934Z WARN codex_core_plugins::manifest: ignoring interface.defaultPrompt: maximum of 3 prompts is supported\n");
          child.stdout.write(JSON.stringify({ type: "text.delta", agent: "codex", invocationId: "inv-answer", text: "answer" }) + "\n");
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
            child.stdout.write(JSON.stringify({ type: "text.delta", agent: "codex", invocationId: "inv-a2a-1", text: "@Gemini\n请继续实现。\ncodex result" }) + "\n");
          } else {
            child.stdout.write(JSON.stringify({ type: "text.delta", agent: "gemini", invocationId: "inv-a2a-2", text: "gemini received" }) + "\n");
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
      const messagesResp = await fetch(`${baseUrl}/api/messages?sessionId=${encodeURIComponent(sessionId)}`);
      const body = await messagesResp.json();
      const systemRoutes = (body.messages || []).filter((m) => m.role === "system" && m.kind === "a2a-route");
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

test("frontend restores message spacer before showing empty state after clearing messages", () => {
  const source = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const lines = source.split(/\r?\n/);
  const failures = [];

  lines.forEach((line, index) => {
    if (!line.includes("messagesEl.replaceChildren();")) return;

    const nextLines = lines.slice(index + 1, index + 12);
    const showIndex = nextLines.findIndex((candidate) => candidate.includes("showEmpty();"));
    const ensureIndex = nextLines.findIndex((candidate) => candidate.includes("ensureSpacer();"));

    if (showIndex !== -1 && (ensureIndex === -1 || showIndex < ensureIndex)) {
      failures.push(index + 1);
    }
  });

  assert.deepEqual(failures, []);
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
        body: JSON.stringify({ agent: "opencode", prompt: "hello", projectDir: baseDir, useWorktree: true }),
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
        body: JSON.stringify({ agent: "opencode", prompt: "@Gemini hello", projectDir: baseDir, useWorktree: true }),
      });
      const text = await response.text();

      assert.equal(response.status, 200);
      const sessionId = text.match(/"sessionId":"([^"]+)"/)[1];
      assert.equal(worktreeCalls.length, 1);
      assert.equal(worktreeCalls[0].requestedBaseDir, baseDir);
      assert.equal(worktreeCalls[0].sessionId, sessionId);
      assert.equal(calls[0].cwd, worktreeDir);
      assert.equal(calls[0].env.SHIFT_WORKTREE, "1");
      assert.equal(calls[0].env.SHIFT_WORKTREE_DIR, worktreeDir);
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
          body: JSON.stringify({ agent: "opencode", prompt, sessionId: session.id, projectDir: baseDir, useWorktree: true }),
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
        body: JSON.stringify({ agent: "opencode", prompt: "first", sessionId: session.id, projectDir: baseDir, useWorktree: true }),
      });
      assert.equal(first.status, 200);
      await first.text();

      const second = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "opencode", prompt: "second", sessionId: session.id, projectDir: baseDir, useWorktree: false }),
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

test("chat endpoint does not reuse a readonly provider session after switching the same chat into worktree mode", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-worktree-resume-"));
  const sessionsFile = path.join(tmpDir, "sessions.json");
  const invocationsFile = path.join(tmpDir, "invocations.json");
  const sessionMapRoot = path.join(tmpDir, "session-maps");
  const transcriptsDir = path.join(tmpDir, "transcripts");
  const prevTranscriptDir = process.env.SHIFT_TRANSCRIPT_DIR;
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-worktree-resume-base-"));
  const worktreeDir = path.join(os.tmpdir(), "server-worktree-resume-session");
  const runs = [];

  if (!prevTranscriptDir) process.env.SHIFT_TRANSCRIPT_DIR = transcriptsDir;

  const server = createServer({
    uiToken: TEST_UI_TOKEN,
    sessionsFile,
    invocationsFile,
    sessionMapRoot,
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
    fs.writeFileSync(path.join(sessionMapDir, "sessions.json"), JSON.stringify({
      opencode: {
        sessionId: "readonly-session-1",
        workspaceKey: `base:${baseDir}`,
        updatedAt: "2026-07-02T00:00:00.000Z",
      },
    }, null, 2));

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
    if (!prevTranscriptDir) {
      delete process.env.SHIFT_TRANSCRIPT_DIR;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("chat endpoint resumes the matching provider session after base↔worktree round-trip", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-workspace-roundtrip-"));
  const sessionsFile = path.join(tmpDir, "sessions.json");
  const invocationsFile = path.join(tmpDir, "invocations.json");
  const sessionMapRoot = path.join(tmpDir, "session-maps");
  const transcriptsDir = path.join(tmpDir, "transcripts");
  const prevTranscriptDir = process.env.SHIFT_TRANSCRIPT_DIR;
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-workspace-roundtrip-base-"));
  const worktreeDir = path.join(os.tmpdir(), "server-workspace-roundtrip-wt");
  const runs = [];

  if (!prevTranscriptDir) process.env.SHIFT_TRANSCRIPT_DIR = transcriptsDir;

  const server = createServer({
    uiToken: TEST_UI_TOKEN,
    sessionsFile,
    invocationsFile,
    sessionMapRoot,
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
    fs.writeFileSync(path.join(sessionMapDir, "sessions.json"), JSON.stringify({
      opencode: {
        sessionId: "provider-base-1",
        workspaceKey: `base:${baseDir}`,
        updatedAt: "2026-07-02T00:00:00.000Z",
        byWorkspace: {
          [`base:${baseDir}`]: {
            sessionId: "provider-base-1",
            updatedAt: "2026-07-02T00:00:00.000Z",
          },
          [`worktree:${worktreeDir}`]: {
            sessionId: "provider-wt-1",
            updatedAt: "2026-07-02T01:00:00.000Z",
          },
        },
      },
    }, null, 2));

    // Seed a session worktree link so useWorktree can reuse it.
    const sessionsData = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
    sessionsData.sessions[session.id].worktree = {
      sessionId: session.id,
      baseDir,
      worktreeDir,
      branch: `codex/session-${session.id}`,
      status: "active",
      createdAt: "2026-07-02T00:00:00.000Z",
    };
    sessionsData.sessions[session.id].projectDir = baseDir;
    fs.writeFileSync(sessionsFile, `${JSON.stringify(sessionsData, null, 2)}\n`, "utf8");

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

    assert.equal(runs.length, 2);
    assert.equal(runs[0].cwd, worktreeDir);
    assert.equal(runs[0].env.INVOKE_SESSION_ID, "provider-wt-1");
    assert.equal(runs[0].env.INVOKE_WORKSPACE_KEY, `worktree:${worktreeDir}`);
    assert.equal(runs[1].cwd, baseDir);
    assert.equal(runs[1].env.INVOKE_SESSION_ID, "provider-base-1");
    assert.equal(runs[1].env.INVOKE_WORKSPACE_KEY, `base:${baseDir}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
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
          return { sessionId, branch: "codex/session-x", clean: false, porcelain: [" M server.js"] };
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

      const discardResponse = await fetch(`${baseUrl}/api/sessions/${session.id}/worktree/discard`, { method: "POST" });
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
  assert.deepEqual(parseA2AMentions("```\n@gemini 帮我\n```\n@OpenCode 看下", "codex"), ["opencode"]);
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
    async (baseUrl) => {
      // Create a session explicitly so both chats target the same id.
      const created = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
      const { session } = await created.json();

      // Start first long-running chat.
      const first = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "codex", prompt: "long task", sessionId: session.id }),
      });
      assert.equal(first.status, 200);

      // Start second chat on the same session: it should abort the first.
      const second = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "opencode", prompt: "new task", sessionId: session.id }),
      });
      assert.equal(second.status, 200);

      const text = await second.text();
      assert.match(text, /event: agent-start\ndata: \{"agent":"opencode","invocationId":"[^"]+"\}/);
      assert.equal(callCount, 2);
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
        body: JSON.stringify({ agent: "opencode", prompt: "replacement task", sessionId: session.id }),
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
          new Promise((_, reject) => setTimeout(() => reject(new Error("first chat did not close")), 2000)),
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
    sessionsFile: "/tmp/sessions.json",
    tokens: new Map(),
  };

  const invocationId = "invocation-cb-1";
  const callbackToken = "token-cb-1";
  threadCtx.tokens.set(invocationId, { agentId: "codex", callbackToken });
  callbacks.registerThread(sessionId, threadCtx);

  const appended = [];
  const appendFn = (file, sid, msg) => appended.push({ file, sid, msg });

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
  assert.match(joined, /event: message\ndata: \{"agent":"codex","role":"assistant","text":"@Gemini 请继续实现"\}/);
  assert.match(joined, /event: a2a-route\ndata: \{"from":"codex","to":"gemini"/);

  // Same target may re-enter via callback even if already on the worklist.
  const ok2 = callbacks.postMessage(sessionId, invocationId, "@Gemini 请按补充意见继续", {
    appendToSession: appendFn,
  });
  assert.equal(ok2.handoff.status, "accepted");
  assert.deepEqual(worklist, ["codex", "gemini", "gemini"]);
  assert.equal(threadCtx.a2aCount, 2);

  callbacks.unregisterThread(sessionId);
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
    assert.match(sse.join(""), /event: memory-captured/);
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
    assert.match(sse.join(""), /event: memory-captured/);
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
    res: { destroyed: false, writableEnded: false, write() { return true; } },
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
    res: { destroyed: false, writableEnded: false, write() { return true; } },
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
    assert.ok(Math.abs(expiresAt - expected) < 100, `expiresAt should be ~60s in the future, got diff ${Math.abs(expiresAt - expected)}ms`);
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
    res: { destroyed: false, writableEnded: false, write() { return true; } },
    worklist: ["codex"],
    controller: new AbortController(),
    a2aCount: 0,
    sessionsFile: "/tmp/sessions.json",
    tokens: new Map([[invocationId, {
      agentId: "codex",
      callbackToken,
      createdAt: Date.now() - 60_000,
      expiresAt: Date.now() - 1000, // already expired
    }]]),
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
    res: { destroyed: false, writableEnded: false, write() { return true; } },
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
    write(chunk) { sseEvents.push(chunk); return true; },
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
    sessionsFile: "/tmp/sessions.json",
    tokens: new Map(),
  };
  callbacks.registerThread(sessionId, threadCtx);

  const appended = [];
  const appendFn = (file, sid, msg) => appended.push({ file, sid, msg });

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
    write(chunk) { sseEvents.push(chunk); return true; },
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
    sessionsFile: "/tmp/sessions.json",
    tokens: new Map(),
  };
  callbacks.registerThread(sessionId, threadCtx);

  const appended = [];
  const appendFn = (file, sid, msg) => appended.push({ file, sid, msg });

  const ok = callbacks.postMessage(sessionId, "inv-1", "hello", {
    appendToSession: appendFn,
  });

  assert.equal(ok.ok, true);
  assert.equal(ok.handoff.status, "none");
  assert.equal(appended.length, 1);
  // sendSse writes two lines per event (event: + data:), so count by event name.
  const eventNames = sseEvents.filter((line) => line.startsWith("event: ")).map((line) => line.trim());
  assert.deepEqual(eventNames, ["event: message"]);

  callbacks.unregisterThread(sessionId);
});

test("prompt template uses the cross-platform callback client", () => {
  const instructions = callbacks.buildCallbackInstructions("http://127.0.0.1:8787");
  assert.match(instructions, /\$SHIFT_THREAD_ID/);
  assert.match(instructions, /node scripts\/callback-client\.js post-message/);
  assert.doesNotMatch(instructions, /curl -X POST/);
  assert.match(instructions, /TTL/);
});

// ── Transcript integration (lesson 08 Phase 1) ─────────────────

test("chat endpoint writes transcript events (invocation-start, stdout, invocation-end)", async () => {
  const transcript = require("../src/session/transcript");
  const tmpTranscriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-transcript-"));
  const prevDir = process.env.SHIFT_TRANSCRIPT_DIR;
  process.env.SHIFT_TRANSCRIPT_DIR = tmpTranscriptDir;
  try {
    let capturedSessionId = null;

    await withServer(
      {
        spawnRunner(_command, _args) {
          const child = createMockChild();
          process.nextTick(() => {
            child.stdout.write(JSON.stringify({ type: "text.delta", agent: "opencode", invocationId: "inv-transcript", text: "partial " }) + "\n");
            child.stdout.write(JSON.stringify({ type: "text.delta", agent: "opencode", invocationId: "inv-transcript", text: "answer" }) + "\n");
            child.emit("close", 0, null);
          });
          return child;
        },
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent: "opencode", prompt: "hello transcript" }),
        });
        const text = await response.text();
        const sessionMatch = text.match(/event: session\ndata: \{"sessionId":"([^"]+)"\}/);
        assert.ok(sessionMatch);
        capturedSessionId = sessionMatch[1];
      }
    );

    // Poll until the transcript files appear. On Windows, server.close() may
    // resolve before all fs.promises.appendFile writes finish even though the
    // handler awaits flush. Polling is more robust than a fixed sleep.
    async function waitForInvocations(sessionId, minCount, timeoutMs) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        await transcript.flush();
        const invs = await transcript.listInvocations(sessionId);
        if (invs.length >= minCount) return invs;
        await new Promise((r) => setTimeout(r, 50));
      }
      return await transcript.listInvocations(sessionId);
    }

    const invocations = await waitForInvocations(capturedSessionId, 1, 3000);
    assert.ok(invocations.length >= 1, `expected at least one invocation, got: ${JSON.stringify(invocations)}`);

    // Durable path coalesces consecutive text.delta fragments (SSE stays fine-grained).
    const agentInv = invocations.find((id) => id !== "_user_prompt");
    assert.ok(agentInv, "expected a non-user-prompt invocation");
    const events = await transcript.readInvocation(capturedSessionId, agentInv);
    const kinds = events.map((e) => e.kind);
    assert.ok(kinds.includes("invocation-start"), `kinds: ${kinds.join(",")}`);
    assert.ok(kinds.includes("text.delta"), `kinds: ${kinds.join(",")}`);
    assert.ok(kinds.includes("invocation-end"), `kinds: ${kinds.join(",")}`);
    const stdoutEvents = events.filter((e) => e.kind === "text.delta");
    assert.equal(stdoutEvents.length, 1, "coalesced text.delta into one durable segment");
    assert.equal(stdoutEvents[0].payload.text, "partial answer");

    // The synthetic user-prompt invocation should be searchable
    const userPromptEvents = await transcript.readInvocation(capturedSessionId, "_user_prompt");
    assert.equal(userPromptEvents.length, 1);
    assert.equal(userPromptEvents[0].kind, "user-prompt");
      assert.equal(userPromptEvents[0].payload.agent, "opencode");

    // Search should find the user prompt
    const hits = await transcript.searchTranscript(capturedSessionId, "transcript");
    assert.ok(hits.length >= 1, "search should find the user prompt");
  } finally {
    if (prevDir === undefined) delete process.env.SHIFT_TRANSCRIPT_DIR;
    else process.env.SHIFT_TRANSCRIPT_DIR = prevDir;
    fs.rmSync(tmpTranscriptDir, { recursive: true, force: true });
  }
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
            child.stdout.write(JSON.stringify({ type: "text.delta", agent: "opencode", invocationId: "inv-warn", text: "x".repeat(80) }) + "\n");
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
        assert.ok(hasContextEvent, `expected context-warning or sealed event in stream, got: ${text.slice(-500)}`);
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
            child.stdout.write(JSON.stringify({ type: "text.delta", agent: "codex", invocationId: "inv-seal", text: "x".repeat(80) }) + "\n");
            child.stdout.write(JSON.stringify({ type: "text.delta", agent: "codex", invocationId: "inv-seal", text: "\n@sage please continue" }) + "\n");
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
        // The sealed event must fire for the first agent (codex), not after
        // A2A routing to sage.
        assert.match(text, /event: sealed\ndata: \{"agent":"codex".*"reason":"context overflow"\}/);
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
    const resp = await fetch(`${baseUrl}/api/callbacks/session-search?sessionId=x&invocationId=y&query=z`);
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
    const active = body.invocations.find((i) => i.invocationId === captured.env.SHIFT_INVOCATION_ID);
    assert.ok(active, `active invocation should be listed, got: ${JSON.stringify(body.invocations)}`);
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
    // Inject a bunch of stdout events so pagination has something to slice
    const transcript = require("../src/session/transcript");
    const invId = captured.env.SHIFT_INVOCATION_ID;
    for (let i = 0; i < 10; i++) {
      transcript.appendEvent(sid, invId, "stdout", { text: `chunk-${i}` });
    }
    await transcript.flush();

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
  assert.match(tpl, /callback-client\.js list-invocations/);
  assert.match(tpl, /callback-client\.js session-search/);
  assert.match(tpl, /callback-client\.js read-invocation/);
  assert.match(tpl, /callback-client\.js memory-upsert/);
  assert.match(tpl, /callback-client\.js memory-invalidate/);
  assert.match(tpl, /不要凭印象猜/);
});

test("parseUnifiedDiff splits multi-file patches into file entries", () => {
  const { parseUnifiedDiff } = require("../public/workspace-diff.js");
  const diff = [
    "diff --git a/public/app.js b/public/app.js",
    "--- a/public/app.js",
    "+++ b/public/app.js",
    "@@ -1,2 +1,3 @@",
    " line 1",
    "+line 2",
    "diff --git a/public/new-file.js b/public/new-file.js",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/public/new-file.js",
    "@@ -0,0 +1,2 @@",
    "+export const ok = true;",
    "+console.log(ok);",
  ].join("\n");

  const files = parseUnifiedDiff(diff);
  assert.deepEqual(
    files.map((file) => ({ path: file.path, status: file.status })),
    [
      { path: "public/app.js", status: "modified" },
      { path: "public/new-file.js", status: "untracked" },
    ]
  );
  assert.match(files[1].patch, /new file mode 100644/);
});

test("summarizeUnifiedDiff counts total and untracked files", () => {
  const { summarizeUnifiedDiff } = require("../public/workspace-diff.js");
  const files = [
    { path: "public/app.js", status: "modified", patch: "@@ -1 +1,2 @@\n line 1\n+line 2" },
    { path: "public/new-file.js", status: "untracked", patch: "new file mode 100644\n+console.log('ok');" },
  ];

  assert.deepEqual(summarizeUnifiedDiff(files), {
    totalFiles: 2,
    untrackedFiles: 1,
    hasDiff: true,
  });
});

test("frontend index.html exposes explicit worktree mode toggle", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  assert.match(html, /id="use-worktree"/);
  assert.match(html, /title="为本次对话创建或复用隔离 worktree"/);
});

test("frontend exposes all right-panel tabs in a four-column layout", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const workspaceCss = fs.readFileSync(
    path.join(__dirname, "../public", "styles", "workspace.css"),
    "utf8"
  );
  const boot = require("../public/boot.js");
  assert.match(html, /id="panel-tab-agents"/);
  assert.match(html, /id="panel-tab-workspace"/);
  assert.match(html, /id="panel-tab-recall"/);
  assert.match(html, /id="panel-tab-memory"/);
  assert.match(html, /id="workspace-panel"/);
  assert.match(workspaceCss, /grid-template-columns:\s*repeat\(4,/);
  assert.match(html, /src="\/public\/boot\.js"/);
  for (const src of [
    "/public/session-api.js",
    "/public/session-controller.js",
    "/public/worktree-api.js",
    "/public/recall-api.js",
    "/public/chat-client.js",
    "/public/workspace-diff.js",
    "/public/display-helpers.js",
    "/public/theme.js",
    "/public/mention-composer.js",
    "/public/session-list-view.js",
    "/public/workspace-panel.js",
    "/public/recall-panel.js",
    "/public/message-view.js",
    "/public/project-header.js",
    "/public/agent-panel-view.js",
  ]) {
    assert.ok(boot.MODULES.includes(src), `boot MODULES missing ${src}`);
  }
});

test("frontend keeps session-level recall entry only inside the right-side tabs", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const js = fs.readFileSync(path.join(__dirname, "../public", "app.js"), "utf8");
  assert.match(html, /id="panel-tab-recall"/);
  assert.doesNotMatch(html, /id="recall-toggle"/);
  assert.doesNotMatch(js, /const recallToggleEl\s*=\s*\$\("#recall-toggle"\)/);
  assert.doesNotMatch(js, /recallToggleEl\.addEventListener/);
});

test("frontend uses unified Chinese console copy in the main shell", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  assert.match(html, /SHIFT AGENTS · 交班台/);
  assert.match(html, /本会话规则/);
  assert.match(html, />\s*协作者\s*</);
  assert.doesNotMatch(html, /agent-panel-title/);
  // New chat lives in the sidebar only; composer keeps a single Send action.
  assert.match(html, /btn-new-chat/);
  assert.doesNotMatch(html, /id="btn-clear"/);
  assert.match(html, />\s*发送\s*</);
  assert.doesNotMatch(html, />Agent Chat</);
  assert.doesNotMatch(html, />Rules</);
  assert.doesNotMatch(html, />Models</);
});

test("frontend app.js sends useWorktree from the explicit toggle", () => {
  const appJs = fs.readFileSync(path.join(__dirname, "../public", "app.js"), "utf8");
  const chatJs = fs.readFileSync(path.join(__dirname, "../public", "chat-client.js"), "utf8");
  assert.match(appJs, /const useWorktreeInput\s*=\s*\$\("#use-worktree"\)/);
  assert.match(appJs, /window\.ChatClient\.createChatClient/);
  assert.match(chatJs, /useWorktree:\s*useWorktreeInput\.checked/);
});

test("frontend app.js defines invocation-level live run state and renderer hooks", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public", "message-view.js"), "utf8");
  const appJs = fs.readFileSync(path.join(__dirname, "../public", "app.js"), "utf8");
  const boot = require("../public/boot.js");
  assert.match(js, /rt\.liveRuns\.set\(invocationId/);
  assert.match(js, /function applyAgentEvent\(event,\s*sessionId\)/);
  assert.match(js, /function ensureLiveRun\(event,\s*sessionId\)/);
  assert.match(js, /progressItems/);
  assert.match(js, /fileChanges/);
  assert.match(appJs, /createRuntimeStore\(\{\s*bus\s*\}\)|createRuntimeStore\(\)/);
  assert.match(appJs, /createMessageView/);
  assert.ok(boot.MODULES.includes("/public/session-runtime.js"));
});

test("frontend treats sealed SSE event as an expected terminal state", () => {
  const messageView = fs.readFileSync(path.join(__dirname, "../public", "message-view.js"), "utf8");
  const chatJs = fs.readFileSync(path.join(__dirname, "../public", "chat-client.js"), "utf8");
  assert.match(chatJs, /case "sealed":/);
  assert.match(chatJs, /context overflow/);
  assert.match(messageView, /rt\.doneReceived = true/);
  assert.match(messageView, /function finishStream\(statusText,\s*sessionId\)/);
});

test("frontend keeps per-session runtime status and does not abort on switch", () => {
  const messageView = fs.readFileSync(path.join(__dirname, "../public", "message-view.js"), "utf8");
  const sessionList = fs.readFileSync(path.join(__dirname, "../public", "session-list-view.js"), "utf8");
  const controllerJs = fs.readFileSync(path.join(__dirname, "../public", "session-controller.js"), "utf8");
  const chatJs = fs.readFileSync(path.join(__dirname, "../public", "chat-client.js"), "utf8");
  const runtimeJs = fs.readFileSync(path.join(__dirname, "../public", "session-runtime.js"), "utf8");
  const css = readFrontendCss();
  assert.match(controllerJs, /Do not abort the previous session's background run/);
  assert.doesNotMatch(controllerJs, /if \(state\.controller\) \{\s*state\.controller\.abort\(\)/);
  assert.match(messageView, /function remountLiveMessages\(sessionId\)/);
  assert.match(messageView, /function finalizeLiveAgent\(agent, sessionId/);
  assert.match(chatJs, /finalizeLiveAgent\(data\.agent, sessionId/);
  assert.match(chatJs, /systemNotices\.push/);
  assert.match(runtimeJs, /systemNotices:\s*\[\]/);
  assert.match(controllerJs, /systemNotices/);
  assert.match(sessionList, /session-run-status/);
  assert.match(css, /\.session-run-status\.status-running/);
});

test("frontend keeps right-side agent and workspace surfaces in a shared tab system", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public", "app.js"), "utf8");
  assert.match(js, /panelTabAgentsEl\.addEventListener\("click"/);
  assert.match(js, /panelTabWorkspaceEl\.addEventListener\("click"/);
  assert.match(js, /function setRightPanelTab\(nextTab\)/);
  assert.match(js, /activateRightTab\("workspace"\)|loadWorkspaceState\(\)/);
});

test("frontend chunks process-trace hydrate for long histories", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public", "message-view.js"), "utf8");
  assert.match(js, /MESSAGE_VIRTUAL_THRESHOLD/);
  assert.match(js, /scheduleHydrateProcessTrace/);
  assert.match(js, /_hydrateQueue/);
});

test("frontend live stream paints plain text segments; markdown only on finalize", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public", "message-view.js"), "utf8");
  assert.match(js, /liveText\.className = "stream-live-text"/);
  assert.match(js, /function paintStreamSegments/);
  assert.match(js, /stream-live-text/);
  assert.match(js, /function appendLiveSegment/);
  // Live path keeps plain text; finalized path may markdown-paint each text segment.
  assert.match(js, /paintStreamSegments\(item,\s*\{\s*live:\s*true/);
  assert.match(js, /paintStreamSegments\(item,\s*\{\s*live:\s*false,\s*markdown:\s*true/);
  assert.doesNotMatch(js, /function splitIntoSegments/);
  assert.doesNotMatch(js, /stream-suffix/);
});

test("frontend surfaces thinking in a collapsed details block and keeps writing badges", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public", "message-view.js"), "utf8");
  const css = readFrontendCss();
  assert.match(js, /function showThinking\(agent,\s*sessionId\)/);
  assert.match(js, /item\.setBadge\("thinking"\)/);
  assert.match(js, /bubble\.classList\.add\("msg-bubble-live-pending"\)/);
  assert.match(js, /function appendLive\(agent, text,\s*sessionId\)/);
  assert.match(js, /item\.bubble\.classList\.remove\("msg-bubble-live-pending"\)/);
  assert.match(js, /setBadge\(kind === "text" \? "writing" : "thinking"\)/);
  assert.match(js, /msg-thinking/);
  assert.match(js, /thinking\.delta/);
  assert.match(js, /msg-progress/);
  assert.match(js, /progress\.update/);
  assert.match(js, /msg-process/);
  assert.match(js, /wrapProcessDetails/);
  // Collapsed by default; interleaved segments restore think↔text timeline.
  assert.match(js, /open:\s*false/);
  assert.match(js, /function buildContentSegmentsFromEvents/);
  assert.match(js, /msg-stream-segments/);
  assert.match(css, /\.msg-thinking/);
  assert.match(css, /\.msg-progress/);
  assert.match(css, /\.msg-process/);
  assert.match(css, /\.msg-stream-segments/);
});

test("frontend app.js surfaces Codex progress before first text delta", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public", "message-view.js"), "utf8");
  assert.match(js, /function setLivePending\(agent,\s*text,\s*sessionId\)/);
  assert.match(js, /function pendingTextForEvent\(event\)/);
  assert.match(js, /event\.type === "file\.changed"/);
  assert.match(js, /event\.type === "stderr"/);
  assert.match(js, /event\.type === "tool\.started"/);
  assert.match(js, /live-process-status/);
  assert.match(js, /function buildProcessTraceFromRun/);
  assert.match(js, /function buildProcessPanelFromTranscriptEvents/);
  assert.match(js, /function hydrateProcessTrace/);
  assert.match(js, /function upsertLiveTool/);
  assert.match(js, /setLivePending\(event\.agent,\s*pendingTextForEvent\(event\),\s*sid\)/);
  // Nested CLI subagents are not a live protocol surface.
  assert.doesNotMatch(js, /function upsertLiveSubagent/);
});

test("frontend routes stderr SSE into a separate system stderr message", () => {
  const messageView = fs.readFileSync(path.join(__dirname, "../public", "message-view.js"), "utf8");
  const chatJs = fs.readFileSync(path.join(__dirname, "../public", "chat-client.js"), "utf8");
  assert.match(chatJs, /case "stderr":/);
  assert.match(messageView, /function addDebug\(agent, text\)/);
  assert.match(messageView, /createMessage\(\{ role: "system", agent, content: text, variant: "stderr" \}\)/);
  assert.match(chatJs, /addDebug\(data\.agent, data\.text\)/);
  assert.doesNotMatch(messageView, /createMessage\(\{ role: "assistant", agent: data\.agent, content: data\.text, variant: "stderr" \}\)/);
});

test("frontend recall expand uses shared process panel path not flat dump as primary", () => {
  const recallJs = fs.readFileSync(path.join(__dirname, "../public", "recall-panel.js"), "utf8");
  const appJs = fs.readFileSync(path.join(__dirname, "../public", "app.js"), "utf8");
  const helpersJs = fs.readFileSync(
    path.join(__dirname, "../public", "message-process-helpers.js"),
    "utf8"
  );
  const messageViewJs = fs.readFileSync(path.join(__dirname, "../public", "message-view.js"), "utf8");
  // Pure buckets contract lives in helpers; DOM renderer is shared.
  assert.match(helpersJs, /function aggregateProcessBuckets/);
  assert.match(helpersJs, /function textDeltaSummary/);
  assert.match(helpersJs, /function processAnchorFromEvent/);
  assert.match(helpersJs, /function stampEventNos/);
  assert.match(messageViewJs, /function createProcessPanelRenderer/);
  assert.match(appJs, /createProcessPanelRenderer/);
  assert.match(appJs, /buildProcessPanelFromEvents/);
  // Recall primary UI is process panel; raw dump is secondary <details>.
  assert.match(recallJs, /function renderInvocationTrace/);
  assert.match(recallJs, /buildProcessPanelFromEvents/);
  assert.match(recallJs, /emptyFallback:\s*true/);
  assert.match(recallJs, /recall-raw-events/);
  assert.match(recallJs, /rawEvents/);
  // Wave R2: search hits grouped by memory/message/evidence layers.
  assert.match(recallJs, /groupHitsByLayer/);
  assert.match(recallJs, /recall-hit-section/);
  assert.match(recallJs, /recall-hit-layer/);
  assert.match(recallJs, /layer-\$\{layer\}/);
  const recallCss = fs.readFileSync(path.join(__dirname, "../public/styles", "recall.css"), "utf8");
  assert.match(recallCss, /\.recall-layer-chip/);
  assert.match(recallCss, /\.recall-hit-layer\.layer-memory/);
  // Debug dump helper may remain for raw details, but must not be the only path.
  assert.match(recallJs, /function eventBodyText/);
  // Recall copy is locale-driven (N2).
  assert.match(recallJs, /resolveRecallLocale|locale\.recall|R\.toggle/);
  // Phase B: eventNo focus + message anchor navigation.
  assert.match(recallJs, /function focusEventInTrace/);
  assert.match(recallJs, /focusEventNo/);
  assert.match(recallJs, /focusInlineProcess|focusProcessPanel/);
  assert.match(messageViewJs, /function focusProcessPanel/);
  // N1: live final panel uses aggregateProcessBuckets.
  assert.match(messageViewJs, /function buildProcessTraceFromRun/);
  assert.match(messageViewJs, /aggregateProcessBuckets/);
  // Nested <details> must not be toggled by parent row click (冒泡折叠 bug).
  assert.match(recallJs, /bindBodyInteractionGuard|stopPropagation/);
  assert.match(recallJs, /head\.addEventListener\("click"/);
  assert.doesNotMatch(
    recallJs,
    /row\.addEventListener\("click",\s*\(\)\s*=>\s*toggleRecallItem/
  );
});

test("frontend caps recall page size and surfaces truncation state", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public", "recall-panel.js"), "utf8");
  const localeJs = fs.readFileSync(path.join(__dirname, "../public", "locale-zh-CN.js"), "utf8");
  assert.match(js, /readInvocation\(sid,\s*invocationId,\s*\{\s*from:\s*0,\s*limit:\s*200\s*\}\)/);
  // Truncation copy lives in locale.recall.pageTruncated; panel calls it.
  assert.match(js, /pageTruncated/);
  assert.match(localeJs, /pageTruncated:\s*\(shown,\s*total\)/);
});

test("app.js stays an orchestrator under line budget after P0 split", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public", "app.js"), "utf8");
  const lines = js.split(/\r?\n/).length;
  // Budget raised for run-bar / jump-bottom / toast / auto-grow wiring (still no feature bodies inlined).
  assert.ok(lines <= 1000, `app.js has ${lines} lines; expected <= 1000 after UX chrome wiring`);
  assert.match(js, /createMessageView/);
  assert.match(js, /createWorkspacePanel/);
  assert.match(js, /createRecallPanel/);
  assert.match(js, /createMentionComposer/);
  assert.match(js, /createSessionListView/);
  assert.match(js, /createThemeController/);
  assert.match(js, /UiConfirm\.createConfirm|createConfirm\(/);
});

test("frontend styles are split into domain sheets via @import aggregator", () => {
  const main = fs.readFileSync(path.join(__dirname, "../public/styles.css"), "utf8");
  assert.match(main, /@import url\("\.\/styles\/tokens\.css"\)/);
  assert.match(main, /@import url\("\.\/styles\/messages\.css"\)/);
  assert.match(main, /@import url\("\.\/styles\/workspace\.css"\)/);
  assert.match(main, /@import url\("\.\/styles\/a11y\.css"\)/);
  const css = readFrontendCss();
  assert.match(css, /--density/);
  assert.match(css, /\.ui-confirm-dialog/);
  // is-expanded max-height must stay inside the mobile media query; applying it
  // globally caps desktop workspace/recall tabs at ~360px (regression).
  assert.match(
    css,
    /@media\s*\(\s*max-width:\s*700px\s*\)\s*\{[^}]*\.side-panel\.is-expanded\s*\{[^}]*max-height/
  );
});

test("frontend vendors Prism offline and drops jsDelivr CDN", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net\/npm\/prismjs/);
  assert.match(html, /\/public\/vendor\/prism\//);
  assert.ok(fs.existsSync(path.join(__dirname, "../public/vendor/prism/prism.min.js")));
  assert.ok(fs.existsSync(path.join(__dirname, "../public/vendor/prism/prism-tomorrow.min.css")));
});

test("frontend a11y: tab controls, mention listbox, send busy wiring", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(__dirname, "../public", "app.js"), "utf8");
  const mentionJs = fs.readFileSync(path.join(__dirname, "../public", "mention-composer.js"), "utf8");
  assert.match(html, /aria-controls="agent-panel"/);
  assert.match(html, /role="listbox"/);
  assert.match(html, /aria-busy="false"/);
  assert.match(appJs, /aria-busy/);
  assert.match(appJs, /aria-label.*停止生成|停止生成/);
  assert.match(appJs, /ArrowLeft|ArrowRight/);
  assert.match(mentionJs, /role", "option"|role='option'|setAttribute\("role", "option"\)/);
  assert.match(mentionJs, /aria-activedescendant/);
  assert.match(mentionJs, /is-active/);
});

test("frontend uses ui-confirm for destructive actions", () => {
  const boot = require("../public/boot.js");
  const appJs = fs.readFileSync(path.join(__dirname, "../public", "app.js"), "utf8");
  const workspaceJs = fs.readFileSync(path.join(__dirname, "../public", "workspace-panel.js"), "utf8");
  assert.ok(boot.MODULES.includes("/public/ui-confirm.js"));
  assert.match(appJs, /confirmImpl/);
  assert.match(appJs, /删除对话|确认删除/);
  assert.match(workspaceJs, /confirmFn|confirmImpl/);
  assert.match(workspaceJs, /await Promise\.resolve\(confirmFn/);
});

test("frontend distinguishes copy message vs copy code labels", () => {
  const messageView = fs.readFileSync(path.join(__dirname, "../public", "message-view.js"), "utf8");
  const md = fs.readFileSync(path.join(__dirname, "../public", "markdown-lite.js"), "utf8");
  assert.match(messageView, /复制消息/);
  assert.match(messageView, /复制代码|code\.textContent/);
  assert.match(md, /复制代码/);
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
      capturedPrompt.indexOf("<!-- Agent Identity:") < capturedPrompt.indexOf("<!-- Session Identity -->"),
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
            child.stdout.write(JSON.stringify({ type: "text.delta", agent: "codex", invocationId: "bootstrap-a2a-1", text: "@Gemini\nhandoff please\ncodex result" }) + "\n");
          } else {
            child.stdout.write(JSON.stringify({ type: "text.delta", agent: "gemini", invocationId: "bootstrap-a2a-2", text: "gemini received" }) + "\n");
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
  const transcript = require("../src/session/transcript");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-resume-"));
  const prevDir = process.env.SHIFT_TRANSCRIPT_DIR;
  process.env.SHIFT_TRANSCRIPT_DIR = tmpDir;

  const sessionId = "bootstrap-resume-test";
  let firstPrompts = null;
  let secondPrompt = null;

  try {
    await withServer(
      {
        initialSessionIds: [sessionId],
        spawnRunner(command, args) {
          if (!firstPrompts) firstPrompts = [args[args.length - 1]];
          const child = createMockChild();
          process.nextTick(() => {
            child.stdout.write("first done");
            child.emit("close", 0, null);
          });
          return child;
        },
      },
      async (baseUrl) => {
        await (await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent: "opencode", prompt: "first", sessionId }),
        })).text();
      }
    );

    await transcript.flush();
    await new Promise((r) => setTimeout(r, 200));

    await withServer(
      {
        initialSessionIds: [sessionId],
        spawnRunner(command, args) {
          secondPrompt = args[args.length - 1];
          const child = createMockChild();
          process.nextTick(() => {
            child.stdout.write("second done");
            child.emit("close", 0, null);
          });
          return child;
        },
      },
      async (baseUrl) => {
        await (await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent: "opencode", prompt: "second", sessionId }),
        })).text();
      }
    );

    assert.ok(firstPrompts && firstPrompts.length >= 1, "first chat should have run");
    assert.ok(secondPrompt, "second chat should have run");
    assert.match(firstPrompts[0], /第一个 invocation/);
    assert.match(secondPrompt, /<!-- Digest/);
    assert.doesNotMatch(secondPrompt, /第一个 invocation/);
  } finally {
    if (prevDir === undefined) delete process.env.SHIFT_TRANSCRIPT_DIR;
    else process.env.SHIFT_TRANSCRIPT_DIR = prevDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Recall (memory/回忆) tests ────────────────────────────────

test("buildCallbackInstructions includes SHIFT context and recall commands", () => {
  const instructions = callbacks.buildCallbackInstructions("http://example.test", "session-xyz");
  assert.match(instructions, /\$SHIFT_THREAD_ID/);
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
          child.stdout.write(JSON.stringify({ type: "text.delta", agent: "opencode", invocationId: "recall-1", text: "hello recall" }) + "\n");
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
      const invMatch = chatText.match(/event: agent-start\ndata: \{"agent":"opencode","invocationId":"([^"]+)"\}/);
      assert.ok(invMatch, "expected agent-start with invocationId");
      const invId = invMatch[1];

      const listRes = await fetch(`${baseUrl}/api/callbacks/list-invocations?sessionId=${sid}`);
      const list = await listRes.json();
      assert.equal(listRes.status, 200);
      assert.equal(list.invocations.length, 1);
      assert.equal(list.invocations[0].invocationId, invId);
      assert.equal(list.invocations[0].agent, "opencode");
      assert.equal(list.invocations[0].state, "completed");
      assert.ok(list.invocations[0].eventCount >= 3, "should have start + text.delta + stderr + end events");

      const readRes = await fetch(`${baseUrl}/api/callbacks/read-invocation?sessionId=${sid}&targetInvocationId=${invId}`);
      const read = await readRes.json();
      assert.equal(readRes.status, 200);
      assert.equal(read.invocationId, invId);
      assert.equal(read.total, read.events.length);
      const kinds = read.events.map((e) => e.kind);
      assert.ok(kinds.includes("invocation-start"));
      assert.ok(kinds.includes("text.delta"));
      assert.ok(kinds.includes("stderr"));
      assert.ok(kinds.includes("invocation-end"));

      const searchRes = await fetch(`${baseUrl}/api/callbacks/session-search?sessionId=${sid}&query=hello%20recall`);
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
    const res = await fetch(`${baseUrl}/api/callbacks/read-invocation?sessionId=any&targetInvocationId=missing`);
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
    const res = await fetch(`${baseUrl}/api/callbacks/list-invocations?sessionId=s&invocationId=i`, {
      headers: { "x-callback-token": "bad" },
    });
    assert.equal(res.status, 401);
  });
});

test("invocation event helpers are pure and session-scoped", () => {
  const {
    recordInvocationEvent,
    finalizeInvocationEvent,
    listInvocationsFromMap,
    searchInvocationsInMap,
    readInvocationFromMap,
  } = require("../src/server/index");
  const map = new Map();
  map.set("inv-1", {
    invocationId: "inv-1",
    sessionId: "s-1",
    agent: "opencode",
    startedAt: "2026-06-30T10:00:00Z",
    endedAt: null,
    state: "active",
    events: [],
  });
  recordInvocationEvent(map, "inv-1", "stdout", { text: "redis port 6379" });
  recordInvocationEvent(map, "inv-1", "stdout", { text: "done" });
  finalizeInvocationEvent(map, "inv-1", 0, null);

  const list = listInvocationsFromMap(map, "s-1");
  assert.equal(list.length, 1);
  assert.equal(list[0].state, "completed");
  assert.equal(list[0].eventCount, 3);

  const hits = searchInvocationsInMap(map, "s-1", "redis", 10);
  assert.equal(hits.length, 1);
  assert.match(hits[0].snippet, /redis/);

  const read = readInvocationFromMap(map, "s-1", "inv-1", 0, 10);
  assert.equal(read.total, 3);
  assert.equal(read.events.length, 3);
  assert.equal(read.from, 0);
  assert.equal(read.limit, 10);

  assert.equal(listInvocationsFromMap(map, "other").length, 0);
  assert.equal(readInvocationFromMap(map, "other", "inv-1", 0, 10), null);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { persistProviderSession, persistSessionId } = require("../../src/agents/session-persistence");

test("persistProviderSession writes providerKey and workspace slots", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-persist-"));
  const file = path.join(dir, "sessions.json");

  persistProviderSession({
    file,
    agentKey: "codex",
    sessionId: "sess-1",
    workspaceKey: "base:C:\\proj",
    providerKey: "codex:gpt-5.6-sol",
  });

  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.codex.sessionId, "sess-1");
  assert.equal(saved.codex.providerKey, "codex:gpt-5.6-sol");
  assert.equal(saved.codex.byWorkspace["base:C:\\proj"].sessionId, "sess-1");
});

test("persistSessionId reads INVOKE_* env without server imports", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-persist-env-"));
  const file = path.join(dir, "sessions.json");

  persistSessionId(
    { id: "opencode", providerId: "opencode", model: "deepseek-v4-flash" },
    "oc-1",
    {
      INVOKE_SESSION_FILE: file,
      INVOKE_WORKSPACE_KEY: "base:ws",
    }
  );

  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.opencode.sessionId, "oc-1");
  assert.equal(saved.opencode.providerKey, "opencode:deepseek-v4-flash");
  assert.equal(saved.opencode.workspaceKey, "base:ws");
});

test("concurrent provider processes preserve every session mapping", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-persist-race-"));
  const file = path.join(dir, "sessions.json");
  const gate = path.join(dir, "gate");
  const helper = path.resolve(__dirname, "../../test-support/session-map-write-helper.js");
  const agents = ["codex", "gemini", "grok", "opencode"];
  const children = agents.map((agent) =>
    spawn(process.execPath, [helper, file, gate, agent, `${agent}-session`], {
      stdio: ["ignore", "pipe", "pipe"],
    })
  );

  const deadline = Date.now() + 5000;
  while (agents.some((agent) => !fs.existsSync(`${gate}.${agent}.ready`))) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for session-map writers.");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  fs.writeFileSync(`${gate}.go`, "go\n", "utf8");

  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve, reject) => {
          let stderr = "";
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          child.on("error", reject);
          child.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(stderr || `writer exited with ${code}`));
          });
        })
    )
  );

  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(saved).sort(), agents.sort());
  for (const agent of agents) {
    assert.equal(saved[agent].sessionId, `${agent}-session`);
  }
});

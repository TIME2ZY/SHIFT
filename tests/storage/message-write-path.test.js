const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { MESSAGE_TYPES, appendMessage } = require("../../src/storage/message-persistence");
const { createStorage } = require("../../src/storage");

const ROOT = path.resolve(__dirname, "../..");

/**
 * Phase B-3 guard: online hot path must insert messages only via appendMessage
 * (message-persistence), not storage.messages.append in server/agents.
 */
test("online src modules do not call storage.messages.append outside message-persistence", () => {
  const roots = [
    path.join(ROOT, "src", "server"),
    path.join(ROOT, "src", "agents"),
    path.join(ROOT, "src", "session"),
  ];
  const offenders = [];
  for (const dir of roots) {
    walkJs(dir, (file) => {
      const text = fs.readFileSync(file, "utf8");
      if (/\.messages\.append\s*\(/.test(text)) {
        offenders.push(path.relative(ROOT, file));
      }
    });
  }
  assert.deepEqual(offenders, []);
});

test("MESSAGE_TYPES covers assistant-callback and assistant-final", () => {
  assert.ok(MESSAGE_TYPES.has("assistant-final"));
  assert.ok(MESSAGE_TYPES.has("assistant-callback"));
  assert.ok(MESSAGE_TYPES.has("user"));
});

test("appendMessage is the physical write for online inserts", () => {
  const storage = createStorage({ file: ":memory:" });
  try {
    storage.threads.create({
      id: "t-msg",
      title: "",
      projectDir: "",
      lastAgentId: null,
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
    });
    const row = appendMessage(storage, {
      id: "m1",
      threadId: "t-msg",
      role: "assistant",
      agentId: "codex",
      content: "hi",
      messageType: "assistant-callback",
      createdAt: "2026-08-07T00:00:01.000Z",
    });
    assert.equal(row.messageType, "assistant-callback");
    assert.equal(storage.messages.get("m1").content, "hi");
  } finally {
    storage.close();
  }
});

function walkJs(dir, onFile) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(full, onFile);
    else if (entry.isFile() && entry.name.endsWith(".js")) onFile(full);
  }
}

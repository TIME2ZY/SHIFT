const assert = require("node:assert/strict");
const test = require("node:test");

const { createMemoryPanel } = require("../public/memory-panel.js");

test("memory panel discards a stale response after switching sessions", async () => {
  let currentSessionId = "s1";
  const pending = new Map();
  const bodyEl = {
    innerHTML: "",
    querySelectorAll() {
      return [];
    },
  };
  const panel = createMemoryPanel({
    bodyEl,
    memoryApi: {
      listMemories(sessionId) {
        return new Promise((resolve) => pending.set(sessionId, resolve));
      },
    },
    getSessionId: () => currentSessionId,
    escHtml: (value) => String(value),
  });

  const first = panel.load();
  currentSessionId = "s2";
  const second = panel.load();
  pending.get("s2")({
    memories: [{ id: "m2", kind: "fact", status: "captured", content: "new session" }],
    counts: { captured: 1 },
  });
  await second;
  pending.get("s1")({
    memories: [{ id: "m1", kind: "fact", status: "captured", content: "old session" }],
    counts: { captured: 1 },
  });
  await first;

  assert.match(bodyEl.innerHTML, /new session/);
  assert.doesNotMatch(bodyEl.innerHTML, /old session/);
});

test("memory panel hydrates SQLite digest, handoff, and pending conclusions after restart", () => {
  const injectEl = { hidden: true, innerHTML: "" };
  const panel = createMemoryPanel({
    bodyEl: null,
    injectEl,
    memoryApi: {},
    getSessionId: () => "thread-1",
    escHtml: (value) => String(value),
  });

  panel.setContextSnapshot({
    digest: { summary: "当前阻塞：README 缺少初始化。" },
    handoffs: [{ kind: "handoff", content: "下一步：修复 README。" }],
    pendingSuggestions: [
      { proposedKind: "decision", content: "快速开始必须创建 clean epoch。" },
    ],
  });

  assert.equal(injectEl.hidden, false);
  assert.match(injectEl.innerHTML, /SQLite 恢复的上下文/);
  assert.match(injectEl.innerHTML, /README 缺少初始化/);
  assert.match(injectEl.innerHTML, /下一步：修复 README/);
  assert.match(injectEl.innerHTML, /clean epoch/);

  panel.setInjectPreview({
    count: 1,
    items: [{ kind: "handoff", content: "本回合已注入交接" }],
  });
  assert.match(injectEl.innerHTML, /本回合注入 1 条/);
  assert.match(injectEl.innerHTML, /SQLite 恢复的上下文/);
});

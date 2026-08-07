const assert = require("node:assert/strict");
const test = require("node:test");

const {
  renderCollaborationRules,
  buildRosterTable,
  pickExampleTarget,
} = require("../../src/agents/collaboration-rules");
const { AGENTS } = require("../../src/agents/catalog");

test("renderCollaborationRules includes markers and cross-agent routing", () => {
  const text = renderCollaborationRules("codex");
  assert.match(text, /<!-- Collaboration Rules -->/);
  assert.match(text, /<!-- \/Collaboration Rules -->/);
  assert.match(text, /协作铁律/);
  assert.match(text, /行首/);
  assert.match(text, /handoff/);
  assert.match(text, /传球三选一/);
  assert.match(text, /全员共用|共用模板/);
  assert.match(text, /verdict/);
});

test("Grok rules allow CLI subagents but still require @ for cross-agent", () => {
  const text = renderCollaborationRules("grok");
  assert.match(text, /subagent/i);
  assert.match(text, /不强制、不禁止|可自行使用/);
  assert.doesNotMatch(text, /禁止 Grok 内嵌 subagent/);
  assert.doesNotMatch(text, /使用 Task \/ spawn_subagent 开探索子代理 ← 隐式 subagent，禁止/);
  assert.match(text, /行首/);
  assert.match(text, /handoff/);
  assert.match(text, /@Codex|@Gemini|@OpenCode/);
});

test("non-Grok rules still discourage nested subagent as @ substitute", () => {
  const text = renderCollaborationRules("codex");
  assert.match(text, /subagent|Task/i);
  assert.match(text, /跨 Agent/);
});

test("renderCollaborationRules example target is never the current agent", () => {
  for (const id of Object.keys(AGENTS)) {
    const text = renderCollaborationRules(id, AGENTS);
    const selfLabel = AGENTS[id].label;
    // Correct-example line-start @ must not be self.
    assert.doesNotMatch(text, new RegExp(`^\\s*@${selfLabel}\\s*$`, "m"));
    // Explicit self-ban still names current agent.
    assert.match(text, new RegExp(`禁止 @ 自己（你是 ${selfLabel}`));
  }
});

test("pickExampleTarget skips current agent", () => {
  const picked = pickExampleTarget("grok", AGENTS);
  assert.notEqual(picked.id, "grok");
  assert.ok(picked.label);
  assert.deepEqual(pickExampleTarget("solo", { solo: { label: "Solo" } }), {
    id: "teammate",
    label: "Teammate",
  });
});

test("renderCollaborationRules roster lists teammates from catalog", () => {
  const text = renderCollaborationRules("grok", AGENTS);
  assert.match(text, /@Codex/);
  assert.match(text, /@Gemini/);
  assert.match(text, /@OpenCode/);
  assert.match(text, /@Grok/);
  assert.match(text, /禁止 @ 自己/);
  assert.match(text, /Grok/);
});

test("renderCollaborationRules compact mode is short for A2A turns", () => {
  const full = renderCollaborationRules("grok", AGENTS);
  const compact = renderCollaborationRules("grok", AGENTS, { compact: true });
  assert.match(compact, /<!-- Collaboration Rules -->/);
  assert.match(compact, /A2A 精简/);
  assert.match(compact, /handoff/);
  assert.match(compact, /subagent|工具/i);
  assert.doesNotMatch(compact, /传球三选一/);
  assert.ok(compact.length < full.length);
  assert.ok(compact.length < 800);
});

test("renderCollaborationRules accepts injected fake agents", () => {
  const fake = {
    alpha: { label: "Alpha", description: "First mate" },
    beta: { label: "Beta", description: "Second mate" },
  };
  const text = renderCollaborationRules("alpha", fake);
  assert.match(text, /@Alpha/);
  assert.match(text, /@Beta/);
  assert.match(text, /First mate/);
  assert.match(text, /Second mate/);
});

test("buildRosterTable formats agent rows", () => {
  const table = buildRosterTable({
    a: { label: "A", description: "one" },
  });
  assert.match(table, /@A/);
  assert.match(table, /one/);
});

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  roleDisplayName,
  roleBadgeLabel,
  agentLabelFromList,
  agentMention,
  agentMeta,
  agentModelParts,
  agentRoleSummary,
  agentColorIndex,
  fmtTime,
  createDisplayHelpers,
} = require("../public/display-helpers.js");

test("roleDisplayName maps user and agent", () => {
  assert.equal(roleDisplayName("user"), "用户");
  assert.equal(
    roleDisplayName("assistant", "codex", [{ id: "codex", label: "codex" }]),
    "codex"
  );
  assert.equal(roleDisplayName("system"), "系统");
});

test("roleBadgeLabel covers roles", () => {
  assert.equal(roleBadgeLabel("user"), "发起者");
  assert.equal(roleBadgeLabel("assistant"), "Agent");
  assert.equal(roleBadgeLabel("system"), "系统");
});

test("agent helpers format mention and meta", () => {
  assert.equal(agentLabelFromList([{ id: "grok", label: "grok" }], "grok"), "grok");
  assert.equal(agentMention({ id: "x", label: "X" }), "X");
  // Model + effort only — CLI/provider is already shown by avatar + name.
  assert.equal(
    agentMeta({ providerId: "codex", model: "gpt-5.6-sol", reasoningEffort: "high" }),
    "gpt-5.6-sol · high"
  );
  assert.equal(agentMeta({ providerId: "grok", model: "grok-4.5" }), "grok-4.5");
  assert.doesNotMatch(
    agentMeta({ providerId: "opencode", model: "qwen3.7-plus" }),
    /opencode|xAI|Antigravity|codex/i
  );
  assert.deepEqual(
    agentModelParts({ model: "gpt-5.6-sol", reasoningEffort: "high" }),
    { model: "gpt-5.6-sol", effort: "high", tags: [] }
  );
  assert.equal(agentRoleSummary({ description: "a".repeat(40) }).length, 33);
});

test("agentMeta appends capability tags when capabilities are present", () => {
  const meta = agentMeta({
    providerId: "codex",
    model: "gpt-5.6-sol",
    capabilities: { thinking: false, tools: true, resume: true },
  });
  assert.match(meta, /^gpt-5\.6-sol · /);
  assert.match(meta, /工具/);
  assert.doesNotMatch(meta, /子代理/);
  assert.doesNotMatch(meta, /思考/);
  assert.doesNotMatch(meta, /codex|xAI|CLI/i);
});

test("agentColorIndex is stable for known agents and in 1..6", () => {
  assert.equal(agentColorIndex("codex"), 1);
  assert.equal(agentColorIndex("gemini"), 2);
  assert.equal(agentColorIndex("grok"), 3);
  assert.equal(agentColorIndex("opencode"), 4);
  assert.equal(agentColorIndex("codex"), agentColorIndex("codex"));
  const unknown = agentColorIndex("custom-agent-xyz");
  assert.ok(unknown >= 1 && unknown <= 6);
});

test("fmtTime returns relative labels", () => {
  const now = Date.now();
  assert.equal(fmtTime(new Date(now - 30_000).toISOString(), now), "刚刚");
  assert.equal(fmtTime(new Date(now - 5 * 60_000).toISOString(), now), "5m");
});

test("createDisplayHelpers binds agents list", () => {
  const helpers = createDisplayHelpers({
    getAgents: () => [{ id: "opencode", label: "opencode" }],
  });
  assert.equal(helpers.agentLabel("opencode"), "opencode");
  assert.equal(helpers.roleDisplayName("assistant", "opencode"), "opencode");
});

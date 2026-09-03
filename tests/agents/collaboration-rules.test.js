const assert = require("node:assert/strict");
const test = require("node:test");

const {
  renderCollaborationRules,
  buildRosterTable,
  pickExampleTarget,
} = require("../../src/agents/collaboration-rules");
const { AGENTS } = require("../../src/agents/catalog");

test("routing contract is provider-neutral and delegates behavior to the Duty Skill", () => {
  const text = renderCollaborationRules("grok", AGENTS);
  assert.match(text, /<!-- Collaboration Rules -->/);
  assert.match(text, /<!-- \/Collaboration Rules -->/);
  assert.match(text, /无行首 @、无结构化 handoff\.to 时继续由当前 Seat/);
  assert.match(text, /当前 Thread 已启用的 Seat/);
  assert.match(text, /具体操作步骤以当前 Duty Skill 为准/);
  assert.doesNotMatch(text, /reviewer|implementer|唯一.*交付|固定岗位/i);
});

test("routing contract lists only the supplied enabled Seats", () => {
  const enabled = {
    alpha: { label: "Alpha" },
    beta: { label: "Beta" },
  };
  const text = renderCollaborationRules("alpha", enabled);
  assert.match(text, /@Alpha/);
  assert.match(text, /@Beta/);
  assert.doesNotMatch(text, /@Codex|@Gemini|@Grok|@OpenCode/);
});

test("buildRosterTable formats Seat labels and provider keys", () => {
  const table = buildRosterTable({ a: { label: "A" } });
  assert.match(table, /\| @A \| a \|/);
  assert.equal(buildRosterTable({}), "| （仅当前 Seat） | — |");
});

test("pickExampleTarget skips the current Seat and has a neutral fallback", () => {
  const picked = pickExampleTarget("grok", AGENTS);
  assert.notEqual(picked.id, "grok");
  assert.ok(picked.label);
  assert.deepEqual(pickExampleTarget("solo", { solo: { label: "Solo" } }), {
    id: "enabled-seat",
    label: "EnabledSeat",
  });
});

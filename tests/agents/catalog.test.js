const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { afterEach, test } = require("node:test");

const {
  AGENTS,
  DEFAULT_AGENTS,
  applyAgentBindings,
  getModelProfile,
  loadAgentBindings,
  loadAgentCatalogFromHome,
  mergeAgentCatalog,
  resetAgentCatalog,
  resolveModelProfile,
} = require("../../src/agents/catalog");
const { buildInvocation } = require("../../src/agents/invoke-cli");

afterEach(() => {
  resetAgentCatalog();
});

test("code defaults bind Codex, Grok, and Gemini to the current runtime models", () => {
  assert.equal(DEFAULT_AGENTS.codex.model, "gpt-5.6-sol");
  assert.equal(DEFAULT_AGENTS.codex.reasoningEffort, "medium");
  assert.equal(DEFAULT_AGENTS.grok.model, "grok-4.6");
  assert.equal(DEFAULT_AGENTS.grok.reasoningEffort, "high");
  assert.equal(DEFAULT_AGENTS.gemini.model, "gemini-3.8-flash");
  assert.equal(DEFAULT_AGENTS.gemini.reasoningEffort, "high");
  assert.equal(AGENTS.gemini.model, "gemini-3.8-flash");
});

test("known model profiles stay exact; unknown models inherit provider seal data", () => {
  const known = resolveModelProfile("antigravity", "gemini-3.8-flash");
  assert.equal(known.capacitySource, "manual");
  assert.equal(known.sealActionTokens, 300_000);
  assert.equal(getModelProfile("grok", "grok-nope"), null);

  const fallback = resolveModelProfile("grok", "grok-nope");
  assert.equal(fallback.id, "grok-nope");
  assert.equal(fallback.providerId, "grok");
  assert.equal(fallback.capacitySource, "fallback");
  assert.equal(fallback.contextTokens, 500_000);
  assert.deepEqual(fallback.reasoning.levels, ["low", "medium", "high"]);
});

test("bindings overlay defaults without adding providers", () => {
  const merged = mergeAgentCatalog({
    gemini: { model: "gemini-3.7-flash", reasoningEffort: "medium" },
  });
  assert.equal(merged.gemini.model, "gemini-3.7-flash");
  assert.equal(merged.gemini.reasoningEffort, "medium");
  assert.equal(merged.codex.model, DEFAULT_AGENTS.codex.model);
  assert.throws(() => mergeAgentCatalog({ claude: { model: "opus" } }), /Unknown agent "claude"/);
  assert.throws(
    () => mergeAgentCatalog({ gemini: { model: "x", transport: "cli" } }),
    /Unknown binding fields for "gemini"/
  );
});

test("SHIFT_HOME/agents.json is a local binding, not a whitelist", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "shift-agent-bindings-"));
  try {
    assert.deepEqual(loadAgentBindings(path.join(home, "agents.json")), {});
    fs.writeFileSync(
      path.join(home, "agents.json"),
      `${JSON.stringify({
        agents: { gemini: { model: "gemini-3.7-flash", reasoningEffort: "medium" } },
      })}\n`
    );
    loadAgentCatalogFromHome(home);
    assert.equal(AGENTS.gemini.model, "gemini-3.7-flash");
    assert.equal(AGENTS.gemini.reasoningEffort, "medium");
    const inv = buildInvocation(AGENTS.gemini, "hello");
    assert.ok(inv.args.includes("Gemini 3.7 Flash (Medium)"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("invalid agent bindings fail explicitly", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "shift-agent-bindings-bad-"));
  try {
    const file = path.join(home, "agents.json");
    fs.writeFileSync(file, "{ not json");
    assert.throws(() => loadAgentBindings(file), /Invalid agent bindings file/);
    fs.writeFileSync(file, `${JSON.stringify({ seats: {} })}\n`);
    assert.throws(() => loadAgentBindings(file), /Unknown agent bindings keys/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("applyAgentBindings is idempotent over defaults", () => {
  applyAgentBindings({ grok: { model: "grok-4.7" } });
  assert.equal(AGENTS.grok.model, "grok-4.7");
  applyAgentBindings({});
  assert.equal(AGENTS.grok.model, "grok-4.6");
});

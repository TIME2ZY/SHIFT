const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AGENTS } = require("../../src/agents/invoke-cli");
const identity = require("../../src/agents/identity");

const {
  DEFAULT_IDENTITIES_DIR,
  loadIdentities,
  getIdentity,
  renderIdentityBlock,
  renderFallbackIdentityBlock,
  publicIdentities,
  assertIdentitiesForAgents,
  resetIdentityCache,
} = identity;

test.beforeEach(() => {
  resetIdentityCache();
});

test("default identities dir contains one file per catalog agent", () => {
  const map = loadIdentities(DEFAULT_IDENTITIES_DIR);
  for (const id of Object.keys(AGENTS)) {
    assert.ok(map.has(id), `missing identity for ${id}`);
    const rec = map.get(id);
    assert.equal(rec.id, id);
    assert.ok(rec.label, `${id} needs label`);
    assert.ok(rec.body.includes("你是谁") || rec.body.length > 20, `${id} body too thin`);
  }
});

test("getIdentity returns catalog agents and null for unknown", () => {
  assert.equal(getIdentity("grok").label, "Grok");
  assert.equal(getIdentity("no-such-agent"), null);
  assert.equal(getIdentity(""), null);
});

test("renderIdentityBlock includes provider identity without a fixed workflow role", () => {
  const block = renderIdentityBlock("opencode");
  assert.match(block, /<!-- Agent Identity: opencode \/ OpenCode -->/);
  assert.match(block, /<!-- \/Agent Identity -->/);
  assert.match(block, /Role: provider/);
  assert.doesNotMatch(block, /reviewer_deliverer|Workflow role|Workflow capabilities|Duties:/);
  assert.match(block, /你是 \*\*OpenCode/);
  assert.ok(!block.includes("你是 **Grok"), "must not leak other agent bodies");
});

test("identity packs stay provider-only without Duty playbooks", () => {
  const codex = renderIdentityBlock("codex");
  const gemini = renderIdentityBlock("gemini");
  const grok = renderIdentityBlock("grok");
  const opencode = renderIdentityBlock("opencode");

  for (const block of [codex, gemini, grok, opencode]) {
    assert.match(block, /不承担固定岗位/);
    assert.match(block, /Duty Skill/);
  }

  for (const block of [codex, gemini, grok, opencode]) {
    assert.doesNotMatch(block, /```implementation_plan/);
    assert.doesNotMatch(block, /```solution_baseline/);
    assert.doesNotMatch(block, /```final_acceptance/);
    assert.doesNotMatch(block, /```code_review/);
    assert.doesNotMatch(block, /```delivery_receipt/);
    assert.doesNotMatch(block, /# 工作方式/);
  }
});

test("search conventions live in AGENTS.md rather than Codex identity", () => {
  const identity = renderIdentityBlock("codex");
  assert.doesNotMatch(identity, /rg --no-ignore/);
  assert.doesNotMatch(identity, /data\/runtime/);
  const agentsMd = fs.readFileSync(path.join(__dirname, "../../AGENTS.md"), "utf8");
  assert.match(agentsMd, /搜索与读取/);
  assert.match(agentsMd, /data\/runtime/);
});

test("renderIdentityBlock falls back when file missing", () => {
  const block = renderIdentityBlock("ghost", {
    label: "幽灵",
    description: "仅用于测试的 fallback",
  });
  assert.match(block, /<!-- Agent Identity: ghost \/ 幽灵 -->/);
  assert.match(block, /仅用于测试的 fallback/);
  assert.match(block, /<!-- \/Agent Identity -->/);
});

test("renderFallbackIdentityBlock works without description", () => {
  const block = renderFallbackIdentityBlock("x", { label: "X" });
  assert.match(block, /你是 \*\*X\*\*/);
  assert.match(block, /id: `x`/);
});

test("loadIdentities reads custom dir with frontmatter", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "identity-test-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "alpha.md"),
      [
        "---",
        "id: alpha",
        "label: 阿尔法",
        "role: scout",
        "duties:",
        "  - 探路",
        "boundaries:",
        "  - 不决策",
        "---",
        "",
        "# 你是谁",
        "",
        "你是阿尔法。",
        "",
      ].join("\n"),
      "utf8"
    );
    const map = loadIdentities(tmp);
    assert.equal(map.size, 1);
    const alpha = map.get("alpha");
    assert.equal(alpha.label, "阿尔法");
    assert.equal(alpha.role, "scout");
    assert.deepEqual(alpha.duties, ["探路"]);
    assert.deepEqual(alpha.boundaries, ["不决策"]);
    assert.match(alpha.body, /你是阿尔法/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadIdentities skips files without frontmatter", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "identity-test-"));
  try {
    fs.writeFileSync(path.join(tmp, "bare.md"), "# no frontmatter\n", "utf8");
    const map = loadIdentities(tmp);
    assert.equal(map.size, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("publicIdentities returns metadata without body", () => {
  const list = publicIdentities();
  assert.ok(list.length >= 4);
  const coder = list.find((a) => a.id === "grok");
  assert.ok(coder);
  assert.equal(coder.label, "Grok");
  assert.ok(Array.isArray(coder.duties));
  assert.equal(coder.role, "provider");
  assert.deepEqual(coder.duties, []);
  assert.equal("workflowRole" in coder, false);
  assert.equal("workflowCapabilities" in coder, false);
  assert.equal("workflowResponsibilities" in coder, false);
  assert.equal("body" in coder, false);
});

test("assertIdentitiesForAgents reports missing ids", () => {
  const missing = assertIdentitiesForAgents(["grok", "missing-one", "missing-two"]);
  assert.deepEqual(missing, ["missing-one", "missing-two"]);
});

test("assertIdentitiesForAgents strict mode throws", () => {
  assert.throws(
    () => assertIdentitiesForAgents(["nope"], { strict: true }),
    /Missing agent identity files/
  );
});

test("assertIdentitiesForAgents passes for full catalog", () => {
  const missing = assertIdentitiesForAgents(Object.keys(AGENTS));
  assert.deepEqual(missing, []);
});

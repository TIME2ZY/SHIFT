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

test("renderIdentityBlock includes markers, role meta, and body", () => {
  const block = renderIdentityBlock("opencode");
  assert.match(block, /<!-- Agent Identity: opencode \/ OpenCode -->/);
  assert.match(block, /<!-- \/Agent Identity -->/);
  assert.match(block, /Role: reviewer_deliverer/);
  assert.match(block, /Workflow role: reviewer_deliverer/);
  assert.match(block, /Workflow capabilities: review, deliver, recall/);
  assert.match(block, /Duties:/);
  assert.match(block, /Boundaries:/);
  assert.match(block, /你是 \*\*OpenCode/);
  assert.ok(!block.includes("你是 **Grok"), "must not leak other agent bodies");
});

test("identity packs encode the agreed four-agent responsibility split", () => {
  const codex = renderIdentityBlock("codex");
  const gemini = renderIdentityBlock("gemini");
  const grok = renderIdentityBlock("grok");
  const opencode = renderIdentityBlock("opencode");

  assert.match(codex, /开始与末尾把关/);
  assert.match(codex, /用户最初目标.*收敛方案/);
  assert.match(gemini, /正常可行/);
  assert.match(gemini, /不为新奇而新奇/);
  assert.match(grok, /第一轮只读检查/);
  assert.match(grok, /尚未修改/);
  assert.match(opencode, /commit、push 和 PR/);
  assert.match(opencode, /不替代 Codex/);
});

test("Codex identity instructs bounded searches and explicit runtime log access", () => {
  const block = renderIdentityBlock("codex");

  assert.match(block, /src.*public.*tests.*scripts.*docs/);
  assert.match(block, /200 行/);
  assert.match(block, /rg --no-ignore/);
  assert.match(block, /data\/runtime/);
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
  assert.equal(coder.workflowRole, "implementer");
  assert.deepEqual(coder.workflowCapabilities, ["plan", "implement", "fix", "recall"]);
  assert.ok(coder.workflowResponsibilities.includes("change_summary"));
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

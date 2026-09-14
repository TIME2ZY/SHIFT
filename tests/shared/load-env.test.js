const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseEnvContent, applyEnv, loadProjectEnv } = require("../../src/shared/load-env");

describe("parseEnvContent", () => {
  it("parses KEY=VALUE, comments, export, and quotes", () => {
    const parsed = parseEnvContent(`
# comment
PORT=8787
export GROK_PROXY=http://127.0.0.1:7892
INVOKE_CODEX_HOME="C:\\Users\\me\\.codex-cli"
EMPTY=
QUOTED='single'
`);
    assert.equal(parsed.PORT, "8787");
    assert.equal(parsed.GROK_PROXY, "http://127.0.0.1:7892");
    assert.equal(parsed.INVOKE_CODEX_HOME, "C:\\Users\\me\\.codex-cli");
    assert.equal(parsed.EMPTY, "");
    assert.equal(parsed.QUOTED, "single");
    assert.equal(parsed["# comment"], undefined);
  });

  it("skips invalid keys and lines without =", () => {
    const parsed = parseEnvContent(`
not-a-key=1
=no-key
bareline
_OK=yes
`);
    assert.equal(parsed["not-a-key"], undefined);
    assert.equal(parsed._OK, "yes");
  });
});

describe("applyEnv", () => {
  it("does not override existing keys by default", () => {
    const env = { PORT: "1" };
    const applied = applyEnv({ PORT: "2", GROK_PROXY: "http://x" }, env);
    assert.equal(env.PORT, "1");
    assert.equal(env.GROK_PROXY, "http://x");
    assert.deepEqual(applied, ["GROK_PROXY"]);
  });

  it("overrides when requested", () => {
    const env = { PORT: "1" };
    applyEnv({ PORT: "2" }, env, { override: true });
    assert.equal(env.PORT, "2");
  });
});

describe("loadProjectEnv", () => {
  /** @type {string} */
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shift-load-env-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads .env then lets .env.local win for file values", () => {
    fs.writeFileSync(path.join(tmpDir, ".env"), "A=from-env\nB=env-only\n");
    fs.writeFileSync(path.join(tmpDir, ".env.local"), "A=from-local\n");
    const env = {};
    const result = loadProjectEnv(tmpDir, { env });
    assert.equal(env.A, "from-local");
    assert.equal(env.B, "env-only");
    assert.equal(result.loaded.length, 2);
    assert.ok(result.applied.includes("A"));
    assert.ok(result.applied.includes("B"));
  });

  it("keeps process env over file values", () => {
    fs.writeFileSync(path.join(tmpDir, ".env"), "GROK_PROXY=http://file\n");
    const env = { GROK_PROXY: "http://shell" };
    loadProjectEnv(tmpDir, { env });
    assert.equal(env.GROK_PROXY, "http://shell");
  });

  it("is a no-op when files are missing", () => {
    const env = {};
    const result = loadProjectEnv(tmpDir, { env });
    assert.deepEqual(result.loaded, []);
    assert.deepEqual(result.applied, []);
  });
});

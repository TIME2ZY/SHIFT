const assert = require("node:assert/strict");
const test = require("node:test");
const {
  resolveProxy,
  resolveGrokOnlyProxy,
  resolveProviderProxy,
  proxyEnvVars,
} = require("../../src/agents/proxy");

test("resolveProxy prefers explicit option over env", () => {
  assert.equal(
    resolveProxy(
      { proxy: "http://opt:1" },
      { INVOKE_CLI_PROXY: "http://env:1", HTTPS_PROXY: "http://https:1" }
    ),
    "http://opt:1"
  );
});

test("resolveProxy prefers INVOKE_CLI_PROXY over HTTPS_PROXY", () => {
  assert.equal(
    resolveProxy({}, { INVOKE_CLI_PROXY: "http://invoke:1", HTTPS_PROXY: "http://https:1" }),
    "http://invoke:1"
  );
});

test("resolveProxy falls back to HTTPS_PROXY then HTTP_PROXY", () => {
  assert.equal(resolveProxy({}, { HTTPS_PROXY: "http://https:1" }), "http://https:1");
  assert.equal(resolveProxy({}, { HTTP_PROXY: "http://http:1" }), "http://http:1");
  assert.equal(resolveProxy({}, { https_proxy: "http://lower:1" }), "http://lower:1");
});

test("resolveProxy returns empty when nothing set", () => {
  assert.equal(resolveProxy({}, {}), "");
});

test("resolveGrokOnlyProxy reads GROK_PROXY family only", () => {
  assert.equal(
    resolveGrokOnlyProxy({ GROK_PROXY: "http://grok:1", HTTPS_PROXY: "http://https:1" }),
    "http://grok:1"
  );
  assert.equal(resolveGrokOnlyProxy({ INVOKE_GROK_PROXY: "http://ig:1" }), "http://ig:1");
  assert.equal(resolveGrokOnlyProxy({ GROK_HTTP_PROXY: "http://gh:1" }), "http://gh:1");
  assert.equal(resolveGrokOnlyProxy({ HTTPS_PROXY: "http://https:1" }), "");
});

test("resolveProviderProxy: grok prefers GROK_PROXY over global", () => {
  assert.equal(
    resolveProviderProxy(
      "grok",
      {},
      {
        GROK_PROXY: "http://grok:1",
        INVOKE_CLI_PROXY: "http://all:1",
        HTTPS_PROXY: "http://https:1",
      }
    ),
    "http://grok:1"
  );
});

test("resolveProviderProxy: grok falls back to global when GROK_PROXY unset", () => {
  assert.equal(
    resolveProviderProxy("grok", {}, { INVOKE_CLI_PROXY: "http://all:1" }),
    "http://all:1"
  );
});

test("resolveProviderProxy: codex/opencode ignore GROK_PROXY", () => {
  assert.equal(
    resolveProviderProxy(
      "codex",
      {},
      { GROK_PROXY: "http://grok:1", HTTPS_PROXY: "http://https:1" }
    ),
    "http://https:1"
  );
  assert.equal(resolveProviderProxy("opencode", {}, { GROK_PROXY: "http://grok:1" }), "");
  assert.equal(
    resolveProviderProxy(
      "opencode",
      {},
      { GROK_PROXY: "http://grok:1", INVOKE_CLI_PROXY: "http://all:1" }
    ),
    "http://all:1"
  );
});

test("resolveProviderProxy: --proxy wins for any provider", () => {
  assert.equal(
    resolveProviderProxy("grok", { proxy: "http://flag:1" }, { GROK_PROXY: "http://grok:1" }),
    "http://flag:1"
  );
  assert.equal(
    resolveProviderProxy("codex", { proxy: "http://flag:1" }, { INVOKE_CLI_PROXY: "http://all:1" }),
    "http://flag:1"
  );
});

test("proxyEnvVars injects both cases and INVOKE_CLI_PROXY", () => {
  const env = proxyEnvVars("http://127.0.0.1:7892");
  assert.equal(env.HTTP_PROXY, "http://127.0.0.1:7892");
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7892");
  assert.equal(env.http_proxy, "http://127.0.0.1:7892");
  assert.equal(env.https_proxy, "http://127.0.0.1:7892");
  assert.equal(env.ALL_PROXY, "http://127.0.0.1:7892");
  assert.equal(env.INVOKE_CLI_PROXY, "http://127.0.0.1:7892");
  assert.deepEqual(proxyEnvVars(""), {});
});

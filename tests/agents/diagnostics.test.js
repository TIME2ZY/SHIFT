const test = require("node:test");
const assert = require("node:assert/strict");
const { createDiagnosticCollector, stripVolatileParts } = require("../../src/agents/diagnostics");
const { classifyCodexStderr } = require("../../src/agents/providers/codex");

const context = { agent: "codex", invocationId: "inv-diagnostics" };

test("Codex classifier separates benign diagnostics from authentication failures", () => {
  const cache = classifyCodexStderr(
    "2026-07-25T13:56:18Z ERROR codex_models_manager::manager: failed to refresh available models: timeout waiting for child process to exit"
  );
  assert.equal(cache.code, "model_catalog_refresh_timeout");
  assert.equal(cache.severity, "diagnostic");
  assert.equal(cache.affectsRun, false);

  const auth = classifyCodexStderr(
    "2026-07-25T13:31:28Z ERROR manager: 401 Unauthorized: token_invalidated"
  );
  assert.equal(auth.code, "authentication_invalidated");
  assert.equal(auth.severity, "error");
  assert.equal(auth.affectsRun, true);
  assert.equal(auth.visibility, "inline");
});

test("diagnostic collector coalesces repeated lines and captures multiline details", () => {
  const collector = createDiagnosticCollector({ providerId: "codex" });
  const auth = "2026-07-25T13:31:28Z ERROR manager: 401 Unauthorized: token_invalidated";
  assert.equal(collector.add(auth, classifyCodexStderr, context), true);
  assert.equal(collector.add('  "status": 401', classifyCodexStderr, context), true);
  assert.equal(collector.add(auth, classifyCodexStderr, context), true);

  const [event] = collector.flush({ ok: false, eventContext: context });
  assert.equal(event.type, "diagnostic");
  assert.equal(event.code, "authentication_invalidated");
  assert.equal(event.count, 2);
  assert.equal(event.visibility, "inline");
  assert.match(event.providerRaw.text, /"status": 401/);
});

test("diagnostic collector leaves unknown provider stderr untouched", () => {
  const collector = createDiagnosticCollector({ providerId: "opencode" });
  assert.equal(collector.add("unknown warning", undefined, context), false);
  assert.deepEqual(collector.flush({ ok: true, eventContext: context }), []);
});

test("volatile diagnostic fields do not affect fingerprints", () => {
  assert.equal(
    stripVolatileParts("2026-07-25T13:31:28Z ERROR failed, cf-ray: abc-HKG, line 86 column 5"),
    "ERROR failed, cf-ray, line * column *"
  );
});

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildCodexEnvironment, createCodexRuntime } = require("../../src/agents/providers/codex");
const { createProviderRuntime } = require("../../src/agents/providers");

test("Codex child uses the configured isolated home", () => {
  assert.deepEqual(
    buildCodexEnvironment({}, { INVOKE_CODEX_HOME: " C:\\Users\\me\\.codex-cli " }),
    { CODEX_HOME: "C:\\Users\\me\\.codex-cli" }
  );
});

test("Codex child leaves CODEX_HOME unchanged without an override", () => {
  assert.deepEqual(buildCodexEnvironment({}, {}), {});
});

test("turn.completed promotes the last agent_message to text.delta once", () => {
  const runtime = createProviderRuntime({ providerId: "codex", id: "codex", model: "gpt-5.6-sol" });
  const ctx = { agent: "codex", invocationId: "inv-promote" };
  runtime.transform(
    { type: "item.completed", item: { type: "agent_message", text: "checking" } },
    ctx
  );
  runtime.transform(
    { type: "item.completed", item: { type: "agent_message", text: "final review" } },
    ctx
  );
  const completed = runtime.transform(
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4 } },
    ctx
  );
  assert.deepEqual(
    completed.filter((event) => event.type === "text.delta").map((event) => event.text),
    ["final review"]
  );
  const finished = runtime.finish(ctx, { terminal: true, ok: true, exitCode: 0 });
  assert.equal(
    finished.filter((event) => event.type === "text.delta").length,
    0,
    "finish must not duplicate a turn.completed final"
  );
});

test("failed finish promotes the last agent_message when no last-message file exists", () => {
  const runtime = createCodexRuntime({ id: "codex", model: "gpt-5.6-sol" });
  const ctx = { agent: "codex", invocationId: "inv-timeout" };
  runtime.transform(
    { type: "item.completed", item: { type: "agent_message", text: "partial review" } },
    ctx
  );
  const finished = runtime.finish(ctx, {
    terminal: true,
    ok: false,
    signal: "SIGTERM",
  });
  assert.deepEqual(
    finished.filter((event) => event.type === "text.delta").map((event) => event.text),
    ["partial review"]
  );
});

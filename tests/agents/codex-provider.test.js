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

test("turn.completed final is not misclassified as empty at process exit", () => {
  const runtime = createProviderRuntime({
    providerId: "codex",
    id: "codex",
    model: "gpt-5.6-sol",
    invocationArtifacts: {
      finalOutputPath: require("node:path").join(
        require("node:os").tmpdir(),
        `shift-missing-final-${require("node:crypto").randomUUID()}.txt`
      ),
    },
  });
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
    finished.some((event) => event.type === "run.failed"),
    false
  );
  assert.equal(
    finished.some((event) => event.type === "run.finished"),
    true
  );
  assert.equal(
    finished.filter((event) => event.type === "text.delta").length,
    0,
    "finish must not duplicate a turn.completed final"
  );
});

test("Codex live agent_message is commentary until one final text.delta", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  const finalOutputPath = path.join(os.tmpdir(), `shift-codex-contract-${process.pid}.txt`);
  fs.writeFileSync(finalOutputPath, "file should not replace promoted final", "utf8");
  const runtime = createProviderRuntime({
    providerId: "codex",
    id: "codex",
    model: "gpt-5.6-sol",
    invocationArtifacts: { finalOutputPath },
  });
  const ctx = { agent: "codex", invocationId: "inv-contract" };
  const live = [
    ...runtime.transform(
      { type: "item.completed", item: { type: "agent_message", text: "checking files" } },
      ctx
    ),
    ...runtime.transform(
      { type: "item.completed", item: { type: "agent_message", text: "ready to ship" } },
      ctx
    ),
  ];
  assert.deepEqual(
    live.filter((event) => event.type === "commentary.delta").map((event) => event.text),
    ["checking files", "ready to ship"]
  );
  assert.equal(
    live.filter((event) => event.type === "text.delta").length,
    0,
    "live Codex text must stay commentary.delta"
  );

  const completed = runtime.transform({ type: "turn.completed" }, ctx);
  assert.deepEqual(
    completed.filter((event) => event.type === "text.delta").map((event) => event.text),
    ["ready to ship"]
  );
  assert.equal(
    runtime
      .finish(ctx, { terminal: true, ok: true, exitCode: 0 })
      .filter((event) => event.type === "text.delta").length,
    0,
    "finish must not emit a second final after turn.completed"
  );
  assert.equal(fs.existsSync(finalOutputPath), false);
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

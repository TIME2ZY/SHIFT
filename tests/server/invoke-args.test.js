const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createInvokeArgsBuilder } = require("../../src/server/invoke-args");

test("invoke argument builder owns request validation but leaves provider options to adapters", () => {
  const runnerPath = path.resolve("runtime", "src", "agents", "invoke-cli.js");
  const builder = createInvokeArgsBuilder({
    agents: { codex: { providerId: "codex" } },
    runnerPath,
  });

  assert.deepEqual(builder.buildChatArgs("codex", "hello", "augmented"), [
    runnerPath,
    "--agent",
    "codex",
    "augmented",
  ]);
  assert.throws(
    () => builder.buildInvokeArgs({ agent: "missing", prompt: "hi" }),
    /Unsupported agent/
  );
  assert.throws(
    () => builder.buildInvokeArgs({ agent: "codex", prompt: " " }),
    /Prompt is required/
  );
});

test("invoke argument builder rejects a relative runner path", () => {
  assert.throws(
    () =>
      createInvokeArgsBuilder({
        agents: { codex: { providerId: "codex" } },
        runnerPath: "src/agents/invoke-cli.js",
      }),
    /runner path must be absolute/i
  );
});

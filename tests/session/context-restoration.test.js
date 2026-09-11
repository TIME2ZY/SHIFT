const test = require("node:test");
const assert = require("node:assert/strict");
const { recordContextRestoration } = require("../../src/session/context-restoration");
const { renderWindowSealMemory } = require("../../src/storage/memory-capture");

test("restoration cannot claim a packet that was not included or could not be persisted", () => {
  const input = {
    threadId: "t",
    invocationId: "i",
    prompt: "new prompt",
    seals: [{ sealId: "s", content: "missing" }],
    eventStore: {
      append() {
        throw Error("must not write");
      },
    },
  };
  assert.throws(() => recordContextRestoration(input), /missing from invocation prompt/);
  assert.throws(
    () =>
      recordContextRestoration({
        ...input,
        prompt: "missing",
        eventStore: { append: () => ({ ok: false }) },
      }),
    /Could not persist/
  );
});

test("seal preserves authoritative goal and actionable progress before noisy transcript", () => {
  const packet = renderWindowSealMemory({
    agentId: "grok",
    generation: 2,
    userGoal: "continue",
    reason: "post-turn-soft",
    partial: false,
    task: {
      goalOriginal: "Original request",
      artifacts: {
        userGoal: { text: "Actual requirement" },
        progress: {
          next_action: "Fix the remaining restart test",
          verification: ["node --test: passed; abc; log /tmp/tests"],
        },
      },
    },
    workspace: { branch: "codex/task", headSha: "a".repeat(40), changes: [" M src/a.js"] },
    assistantContent: "verbose output".repeat(5000),
  });
  assert.match(packet, /Actual requirement/);
  assert.match(packet, /Fix the remaining restart test/);
  assert.match(packet, /log \/tmp\/tests/);
  assert.match(packet, /src\/a.js/);
  assert.ok(packet.length <= 2048);
});

"use strict";

const crypto = require("node:crypto");

// Evidence describes the actual prepared input, not a claim that the model understood it.
function recordContextRestoration({
  eventStore,
  threadId,
  invocationId,
  prompt,
  seals,
  taskVersion,
}) {
  if (!seals?.length) return;
  const unique = [...new Map(seals.map((seal) => [seal.sealId, seal])).values()];
  for (const seal of unique) {
    if (!prompt.includes(seal.content))
      throw new Error("Seal recovery packet missing from invocation prompt.");
  }
  const result = eventStore.append({
    threadId,
    invocationId,
    kind: "context-restored",
    payload: {
      stage: "prompt_prepared",
      taskVersion: taskVersion ?? null,
      promptHash: crypto.createHash("sha256").update(prompt).digest("hex"),
      seals: unique.map(({ content, ...seal }) => ({
        ...seal,
        contentHash: crypto.createHash("sha256").update(content).digest("hex"),
      })),
    },
  });
  if (result?.ok === false) throw new Error("Could not persist context restoration evidence.");
}

module.exports = { recordContextRestoration };

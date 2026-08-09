const assert = require("node:assert/strict");
const test = require("node:test");
const { buildUsageSummary } = require("../../src/storage/usage-summary");

test("usage summary keeps per-agent billing and a separate session total", () => {
  const windows = [
    {
      id: "c1",
      agentId: "codex",
      generation: 1,
      state: "active",
      createdAt: "2026-01-01",
      capacityTokens: 272000,
      reserveRatio: 0.2,
      contextUsedTokens: 100000,
      contextUsageSource: "char_estimated",
      billingInputTokens: 1000,
      billingCachedInputTokens: 400,
      billingOutputTokens: 200,
      billingReasoningTokens: 50,
      billingTotalTokens: 1200,
      billingCostUsd: 0,
    },
    {
      id: "g1",
      agentId: "gemini",
      generation: 1,
      state: "active",
      createdAt: "2026-01-02",
      capacityTokens: 1000000,
      reserveRatio: 0.2,
      contextUsedTokens: 300000,
      contextUsageSource: "provider_exact",
      billingInputTokens: 2000,
      billingCachedInputTokens: 0,
      billingOutputTokens: 300,
      billingReasoningTokens: 100,
      billingTotalTokens: 2300,
      billingCostUsd: 0.25,
    },
  ];
  const summary = buildUsageSummary({ windows: { listForThread: () => windows } }, "thread-1");
  assert.equal(summary.session.totalTokens, 3500);
  assert.equal(summary.session.cachedInputTokens, 400);
  assert.equal(summary.agents.find((entry) => entry.agentId === "codex").billing.totalTokens, 1200);
  const gemini = summary.agents.find((entry) => entry.agentId === "gemini");
  assert.equal(gemini.billing.totalTokens, 2300);
  assert.equal(gemini.context.usableContextTokens, 800000);
  assert.equal(gemini.context.remainingTokens, 500000);
});

test("usage summary prefers an open context window over sealed history", () => {
  const base = {
    agentId: "codex",
    capacityTokens: 272000,
    reserveRatio: 0.2,
    contextUsageSource: "char_estimated",
    billingTotalTokens: 0,
  };
  const summary = buildUsageSummary(
    {
      windows: {
        listForThread: () => [
          { ...base, id: "sealed", generation: 4, state: "sealed", contextUsedTokens: 200000 },
          { ...base, id: "active", generation: 5, state: "active", contextUsedTokens: 1000 },
        ],
      },
    },
    "thread-1"
  );
  assert.equal(summary.agents[0].context.windowId, "active");
  assert.equal(summary.agents[0].context.contextUsedTokens, 1000);
});

test("usage summary repairs historical provider counters into the canonical shape", () => {
  const summary = buildUsageSummary(
    {
      windows: {
        listForThread: () => [
          {
            id: "legacy-grok",
            agentId: "grok",
            generation: 1,
            state: "active",
            capacityTokens: 500000,
            reserveRatio: 0.2,
            billingInputTokens: 7791,
            billingCachedInputTokens: 11136,
            billingOutputTokens: 480,
            billingReasoningTokens: 321,
            billingTotalTokens: 19407,
          },
        ],
      },
    },
    "thread-1"
  );
  assert.deepEqual(summary.session, {
    inputTokens: 18927,
    cachedInputTokens: 11136,
    outputTokens: 480,
    reasoningTokens: 321,
    totalTokens: 19407,
    costUsd: 0,
  });
});

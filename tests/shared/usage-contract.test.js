const assert = require("node:assert/strict");
const test = require("node:test");

const { normalizeBillingUsage } = require("../../src/shared/usage-contract");

test("canonical billing includes cached input and reasoning output exactly once", () => {
  assert.deepEqual(
    normalizeBillingUsage(
      {
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 30,
        reasoningTokens: 10,
      },
      { cachedInputMode: "additional", reasoningOutputMode: "additional" }
    ),
    {
      inputTokens: 140,
      cachedInputTokens: 40,
      outputTokens: 40,
      reasoningTokens: 10,
      totalTokens: 180,
    }
  );
});

test("reported total reconciles legacy provider overhead into canonical components", () => {
  assert.deepEqual(
    normalizeBillingUsage({
      inputTokens: 6,
      cachedInputTokens: 40_214,
      outputTokens: 452,
      totalTokens: 54_902,
    }),
    {
      inputTokens: 54_450,
      cachedInputTokens: 40_214,
      outputTokens: 452,
      reasoningTokens: 0,
      totalTokens: 54_902,
    }
  );
});

test("legacy ACP totals attribute an additional reasoning remainder to output", () => {
  assert.deepEqual(
    normalizeBillingUsage({
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 30,
      reasoningTokens: 10,
      totalTokens: 140,
    }),
    {
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 40,
      reasoningTokens: 10,
      totalTokens: 140,
    }
  );
});

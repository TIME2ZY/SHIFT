const assert = require("node:assert/strict");
const test = require("node:test");
const { resolveSealThresholds } = require("../../src/session/context-budget");
const { getAgentSealThresholds } = require("../../src/session/health");
const { makeSealer } = require("../../src/session/sealer");
const { getAgentModelProfile, MODEL_PROFILES } = require("../../src/agents/catalog");

test("resolveSealThresholds: absolute Gemini cap at 300k / 270k", () => {
  const t = resolveSealThresholds({
    contextTokens: 1_000_000,
    reserveRatio: 0.2,
    nativeCompactRatio: 0.5,
    sealSoftTokens: 270_000,
    sealActionTokens: 300_000,
  });
  assert.equal(t.actionTokens, 300_000);
  assert.equal(t.softTokens, 270_000);
  assert.equal(t.nativeCompactTokens, 500_000);
  assert.ok(t.actionTokens < t.nativeCompactTokens);
  assert.ok(t.physical.action <= 0.3 + 1e-12);
  assert.ok(t.physical.soft < t.physical.action);
  assert.equal(t.source, "absolute-tokens");
});

test("resolveSealThresholds: never exceeds native compact", () => {
  const t = resolveSealThresholds({
    contextTokens: 100_000,
    reserveRatio: 0.2,
    nativeCompactRatio: 0.5,
    sealActionTokens: 90_000, // would be past native 50k
    sealSoftTokens: 80_000,
  });
  assert.ok(t.actionTokens < t.nativeCompactTokens);
  assert.ok(t.softTokens <= t.actionTokens);
});

test("resolveSealThresholds: usable-ratio profiles for Grok-style 85%", () => {
  const t = resolveSealThresholds({
    contextTokens: 500_000,
    reserveRatio: 0.2,
    nativeCompactRatio: 0.85,
    sealSoftUsableRatio: 0.95,
    sealActionUsableRatio: 1.0,
  });
  assert.equal(t.nativeCompactTokens, 425_000);
  assert.equal(t.actionTokens, 400_000);
  assert.equal(t.softTokens, 380_000);
  assert.ok(t.actionTokens < t.nativeCompactTokens);
  assert.equal(t.usable.sealer.action, 1);
  assert.ok(Math.abs(t.usable.softRatio - 0.95) < 1e-9);
});

test("catalog profiles: every agent yields valid sealer thresholds", () => {
  for (const agentId of ["codex", "gemini", "grok", "opencode"]) {
    const budget = getAgentSealThresholds(agentId);
    const sealer = makeSealer({
      warnThreshold: budget.usable.sealer.warn,
      actionThreshold: budget.usable.sealer.action,
      recoveryThreshold: budget.usable.sealer.recovery,
    });
    assert.equal(sealer.thresholds.warn, budget.usable.sealer.warn);
    assert.ok(budget.actionTokens < budget.nativeCompactTokens, agentId);
    assert.ok(budget.softTokens < budget.actionTokens, agentId);
    assert.ok(
      budget.usable.sealer.recovery < budget.usable.sealer.warn,
      `${agentId} recovery < warn`
    );
    assert.ok(
      budget.usable.sealer.warn < budget.usable.sealer.action || budget.usable.sealer.action === 1,
      `${agentId} warn/action order`
    );
  }
});

test("catalog: Codex 258400 @ 90%, OpenCode native 980k, Grok 85%", () => {
  const codex = getAgentModelProfile("codex");
  assert.equal(codex.contextTokens, 258_400);
  assert.equal(codex.nativeCompactRatio, 0.9);

  const grok = getAgentModelProfile("grok");
  assert.equal(grok.contextTokens, 500_000);
  assert.equal(grok.nativeCompactRatio, 0.85);

  const opencode = getAgentModelProfile("opencode");
  assert.equal(opencode.nativeCompactTokens, 980_000);

  const gemini = getAgentModelProfile("gemini");
  assert.equal(gemini.sealActionTokens, 300_000);
  assert.equal(gemini.sealSoftTokens, 270_000);

  assert.equal(MODEL_PROFILES.length, 4);
});

test("shouldSoftSealAfterTurn respects Gemini softRatio ~0.34 usable", () => {
  const { shouldSoftSealAfterTurn } = require("../../src/session/context-budget");
  const budget = getAgentSealThresholds("gemini");
  const usable = budget.usableTokens; // 800k
  // Below soft: no seal
  const low = shouldSoftSealAfterTurn({
    usableContextTokens: usable,
    usedTokens: 200_000,
    softRatio: budget.usable.softRatio,
    nextTurnMinimumBudget: 10_000,
  });
  assert.equal(low.seal, false);

  // At soft tokens
  const high = shouldSoftSealAfterTurn({
    usableContextTokens: usable,
    usedTokens: budget.softTokens,
    softRatio: budget.usable.softRatio,
    nextTurnMinimumBudget: 10_000,
  });
  assert.equal(high.seal, true);
  assert.equal(high.reason, "soft-ratio");
});

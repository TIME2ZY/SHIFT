const assert = require("node:assert/strict");
const test = require("node:test");
const contextHealth = require("../../src/session/health");
const { AGENTS } = require("../../src/agents/invoke-cli");

test("makeTracker uses the configured Codex capacity and 20% reserve", () => {
  const tracker = contextHealth.makeTracker("codex");
  assert.equal(tracker.agentId, "codex");
  assert.equal(tracker.capacityTokens, 258_400);
  assert.equal(tracker.reserveTokens, 51_680);
  assert.equal(tracker.usableContextTokens, 206_720);
  assert.equal(tracker.getUsedChars(), 0);
  assert.equal(tracker.getFillRatio(), 0);
});

test("makeTracker with explicit capacity overrides default", () => {
  const tracker = contextHealth.makeTracker("codex", { capacityTokens: 100_000 });
  assert.equal(tracker.capacityTokens, 100_000);
});

test("makeTracker for unknown agent falls back to default", () => {
  const tracker = contextHealth.makeTracker("nonexistent-agent");
  assert.equal(tracker.capacityTokens, contextHealth.DEFAULT_CAPACITY_TOKENS);
});

test("addInput / addOutput accumulate chars", () => {
  const tracker = contextHealth.makeTracker("codex");
  tracker.addInput(1000);
  tracker.addOutput(500);
  assert.equal(tracker.getUsedChars(), 1500);
});

test("makeTracker resumes persisted window usage", () => {
  const tracker = contextHealth.makeTracker("codex", {
    capacityTokens: 1000,
    inputChars: 1200,
    outputChars: 800,
  });
  assert.equal(tracker.getUsedChars(), 2000);
  assert.equal(tracker.getFillRatio(), 0.625);
  tracker.addOutput(400);
  assert.equal(tracker.getFillRatio(), 0.75);
});

test("addInput / addOutput ignore non-positive values", () => {
  const tracker = contextHealth.makeTracker("codex");
  tracker.addInput(0);
  tracker.addInput(-5);
  tracker.addInput("not a number");
  tracker.addOutput(NaN);
  assert.equal(tracker.getUsedChars(), 0);
});

test("fillRatio is measured against usable capacity after reserve", () => {
  const tracker = contextHealth.makeTracker("codex", { capacityTokens: 1000 });
  // 4000 chars total = 1000 tokens = fillRatio 1.0
  tracker.addInput(2000);
  tracker.addOutput(2000);
  assert.equal(tracker.getPhysicalFillRatio(), 1.0);
  assert.equal(tracker.getFillRatio(), 1.25);
});

test("fillRatio grows monotonically as input/output accumulate", () => {
  const tracker = contextHealth.makeTracker("codex", { capacityTokens: 1000 });
  const r0 = tracker.getFillRatio();
  tracker.addInput(1000);
  const r1 = tracker.getFillRatio();
  tracker.addOutput(1000);
  const r2 = tracker.getFillRatio();
  assert.ok(r0 < r1 && r1 < r2, `expected r0<r1<r2, got ${r0}, ${r1}, ${r2}`);
});

test("snapshot returns a consistent view of all counters", () => {
  // capacity 2000 tokens × 4 chars/token = 8000 char capacity
  const tracker = contextHealth.makeTracker("codex", { capacityTokens: 2000 });
  tracker.addInput(4000);
  tracker.addOutput(4000);
  const snap = tracker.snapshot();
  assert.equal(snap.agentId, "codex");
  assert.equal(snap.capacityTokens, 2000);
  assert.equal(snap.inputChars, 4000);
  assert.equal(snap.outputChars, 4000);
  assert.equal(snap.usedChars, 8000);
  assert.equal(snap.usedTokens, 2000);
  assert.equal(snap.physicalFillRatio, 1.0);
  assert.equal(snap.fillRatio, 1.25);
  assert.ok(typeof snap.elapsedMs === "number" && snap.elapsedMs >= 0);
});

test("agent model capacities match the configured manual limits", () => {
  assert.equal(contextHealth.getAgentCapacity("codex"), 258_400);
  assert.equal(contextHealth.getAgentCapacity("gemini"), 1_000_000);
  assert.equal(contextHealth.getAgentCapacity("opencode"), 1_000_000);
  assert.equal(contextHealth.getAgentCapacity("grok"), 500_000);
  for (const agent of ["codex", "gemini", "opencode", "grok"]) {
    assert.equal(contextHealth.getAgentReserveRatio(agent), 0.2);
  }
});

test("getAgentSealThresholds: Grok/Codex under native; Gemini caps at 300k", () => {
  const grok = contextHealth.getAgentSealThresholds("grok");
  assert.equal(grok.capacityTokens, 500_000);
  assert.equal(grok.nativeCompactTokens, 425_000);
  assert.ok(grok.actionTokens <= 400_000);
  assert.ok(grok.actionTokens < grok.nativeCompactTokens);
  assert.ok(grok.softTokens < grok.actionTokens);
  assert.equal(grok.usable.sealer.action, 1);
  assert.ok(Math.abs(grok.usable.softRatio - 0.95) < 1e-9);

  const codex = contextHealth.getAgentSealThresholds("codex");
  assert.equal(codex.capacityTokens, 258_400);
  assert.equal(codex.nativeCompactTokens, Math.floor(258_400 * 0.9));
  assert.ok(codex.actionTokens < codex.nativeCompactTokens);
  assert.equal(codex.usable.sealer.action, 1);

  const gemini = contextHealth.getAgentSealThresholds("gemini");
  assert.equal(gemini.actionTokens, 300_000);
  assert.equal(gemini.softTokens, 270_000);
  assert.ok(gemini.actionTokens < gemini.nativeCompactTokens);
  assert.ok(gemini.physical.action <= 0.3 + 1e-9);
  assert.ok(gemini.usable.sealer.warn < gemini.usable.sealer.action);
  assert.ok(gemini.usable.sealer.recovery < gemini.usable.sealer.warn);

  const opencode = contextHealth.getAgentSealThresholds("opencode");
  assert.equal(opencode.nativeCompactTokens, 980_000);
  assert.ok(opencode.actionTokens < opencode.nativeCompactTokens);
  assert.ok(opencode.actionTokens <= 800_000);
});

test("exact provider context overrides character estimate while billing stays separate", () => {
  const tracker = contextHealth.makeTracker("codex", { capacityTokens: 1000 });
  tracker.addInput(400);
  tracker.applyUsage({
    type: "usage.update",
    scope: "turn",
    mode: "cumulative",
    inputTokens: 300,
    cachedInputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 20,
    totalTokens: 350,
    contextTokens: 320,
    contextTokensExact: true,
  });
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.usedTokens, 320);
  assert.equal(snapshot.contextUsageSource, "provider_exact");
  assert.equal(snapshot.billing.totalTokens, 350);
  assert.equal(snapshot.billing.cachedInputTokens, 100);
});

test("repeated cumulative usage snapshots are not double counted", () => {
  const tracker = contextHealth.makeTracker("codex");
  const usage = {
    type: "usage.update",
    scope: "turn",
    mode: "cumulative",
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
  };
  tracker.applyUsage(usage);
  tracker.applyUsage(usage);
  assert.equal(tracker.snapshot().billing.totalTokens, 120);
});

test("runtime-reported provider capacity overrides the catalog fallback", () => {
  const tracker = contextHealth.makeTracker("codex", { capacityTokens: 272000 });
  tracker.applyUsage({
    type: "usage.update",
    scope: "turn",
    mode: "cumulative",
    contextWindowTokens: 258400,
    contextTokens: 42000,
    contextTokensExact: true,
  });
  assert.equal(tracker.capacityTokens, 258400);
  assert.equal(tracker.snapshot().contextWindowTokens, 258400);
});

test("Codex provider-session watermarks replace persisted billing across invocations", () => {
  const tracker = contextHealth.makeTracker("codex", {
    billingInputTokens: 1000,
    billingOutputTokens: 100,
    billingTotalTokens: 1100,
  });
  tracker.applyUsage({
    type: "usage.update",
    scope: "turn",
    mode: "cumulative",
    counterScope: "provider-session",
    inputTokens: 1250,
    outputTokens: 150,
    totalTokens: 1400,
  });
  const billing = tracker.snapshot().billing;
  assert.equal(billing.inputTokens, 1250);
  assert.equal(billing.outputTokens, 150);
  assert.equal(billing.totalTokens, 1400);
});

test("estimated context resumes its persisted snapshot and adds only new observed chars", () => {
  const tracker = contextHealth.makeTracker("codex", {
    capacityTokens: 10_000,
    inputChars: 400,
    outputChars: 400,
    contextUsedTokens: 5000,
    contextUsageSource: "char_estimated",
  });
  assert.equal(tracker.getUsedTokens(), 5000);
  tracker.addOutput(400);
  assert.equal(tracker.getUsedTokens(), 5100);
});

test("authoritative run usage reconciles provisional step deltas", () => {
  const tracker = contextHealth.makeTracker("gemini");
  tracker.applyUsage({
    type: "usage.update",
    scope: "step",
    mode: "delta",
    inputTokens: 60,
    outputTokens: 10,
    totalTokens: 70,
  });
  tracker.applyUsage({
    type: "usage.update",
    scope: "step",
    mode: "delta",
    inputTokens: 80,
    outputTokens: 20,
    totalTokens: 100,
  });
  tracker.applyUsage({
    type: "usage.update",
    scope: "run",
    mode: "cumulative",
    inputTokens: 150,
    outputTokens: 30,
    totalTokens: 180,
  });
  const billing = tracker.snapshot().billing;
  assert.equal(billing.inputTokens, 150);
  assert.equal(billing.outputTokens, 30);
  assert.equal(billing.totalTokens, 180);
});

test("getAgentCapacity honors per-agent capacityTokens override", () => {
  // Mutate AGENTS for this test and restore after.
  const original = AGENTS.codex.capacityTokens;
  AGENTS.codex.capacityTokens = 50_000;
  try {
    const tracker = contextHealth.makeTracker("codex");
    assert.equal(tracker.capacityTokens, 50_000);
  } finally {
    if (original === undefined) delete AGENTS.codex.capacityTokens;
    else AGENTS.codex.capacityTokens = original;
  }
});

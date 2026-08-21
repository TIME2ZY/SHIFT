const assert = require("node:assert/strict");
const test = require("node:test");

const {
  decidePolicy,
  canEnqueue,
  resolveHandoffPolicyMode,
  buildRepairPayload,
  evaluatePhaseRoute,
  resolveCollabPhase,
  DECISIONS,
} = require("../../src/agents/handoff-policy");

test("resolveHandoffPolicyMode defaults to balanced", () => {
  assert.equal(resolveHandoffPolicyMode({}), "balanced");
  assert.equal(resolveHandoffPolicyMode({ SHIFT_HANDOFF_POLICY: "soft" }), "soft");
  assert.equal(resolveHandoffPolicyMode({ SHIFT_HANDOFF_POLICY: "STRICT" }), "strict");
  assert.equal(resolveHandoffPolicyMode({ SHIFT_HANDOFF_POLICY: "nope" }), "balanced");
});

test("soft mode never requests repair for missing handoff", () => {
  assert.equal(
    decidePolicy({
      mode: "soft",
      useWorktree: true,
      quality: { hasBlock: false, emptyPacket: true, ok: false },
    }),
    DECISIONS.ALLOW_DEGRADED
  );
  assert.equal(
    decidePolicy({
      mode: "soft",
      quality: { hasBlock: true, ok: true },
    }),
    DECISIONS.ALLOW
  );
});

test("balanced mode repairs worktree empty packet but allows discussion", () => {
  assert.equal(
    decidePolicy({
      mode: "balanced",
      useWorktree: true,
      quality: { hasBlock: false, emptyPacket: true, ok: false },
    }),
    DECISIONS.REQUEST_REPAIR
  );
  assert.equal(
    decidePolicy({
      mode: "balanced",
      useWorktree: false,
      quality: { hasBlock: false, emptyPacket: true, ok: false },
    }),
    DECISIONS.ALLOW_DEGRADED
  );
  assert.equal(
    decidePolicy({
      mode: "balanced",
      useWorktree: true,
      quality: { hasBlock: true, ok: false },
    }),
    DECISIONS.ALLOW_DEGRADED
  );
  assert.equal(
    decidePolicy({
      mode: "balanced",
      quality: { hasBlock: true, ok: true },
    }),
    DECISIONS.ALLOW
  );
});

test("strict mode repairs any non-ok handoff", () => {
  assert.equal(
    decidePolicy({
      mode: "strict",
      useWorktree: false,
      quality: { hasBlock: true, ok: false },
    }),
    DECISIONS.REQUEST_REPAIR
  );
  assert.equal(
    decidePolicy({
      mode: "strict",
      quality: { hasBlock: true, ok: true },
    }),
    DECISIONS.ALLOW
  );
});

test("canEnqueue only allows allow and allow_degraded", () => {
  assert.equal(canEnqueue(DECISIONS.ALLOW), true);
  assert.equal(canEnqueue(DECISIONS.ALLOW_DEGRADED), true);
  assert.equal(canEnqueue(DECISIONS.REQUEST_REPAIR), false);
  assert.equal(canEnqueue(DECISIONS.REJECT), false);
});

test("buildRepairPayload includes example fence", () => {
  const payload = buildRepairPayload({
    fromAgent: "codex",
    toAgent: "opencode",
    mode: "balanced",
    quality: { emptyPacket: true, hasBlock: false, missing: ["what", "why", "next_action"] },
  });
  assert.equal(payload.policy, DECISIONS.REQUEST_REPAIR);
  assert.match(payload.message, /未入队/);
  assert.match(payload.example, /```handoff/);
  assert.match(payload.example, /to: opencode/);
  assert.match(payload.example, /intent:/);
});

test("explicit intents resolve the five workflow phases without changing the reviewer", () => {
  assert.equal(resolveCollabPhase({ intent: "discuss", toAgent: "codex" }), "discuss");
  assert.equal(resolveCollabPhase({ intent: "plan", toAgent: "grok" }), "implement");
  assert.equal(resolveCollabPhase({ intent: "review", toAgent: "opencode" }), "review");
  assert.equal(resolveCollabPhase({ intent: "deliver", toAgent: "opencode" }), "deliver");
  assert.equal(resolveCollabPhase({ intent: "accept", toAgent: "codex" }), "deliver");
  assert.equal(
    resolveCollabPhase({ intent: "discuss", toAgent: "gemini", useWorktree: true }),
    "discuss"
  );

  assert.equal(evaluatePhaseRoute({ intent: "review", toAgent: "opencode" }).ok, true);
  assert.equal(evaluatePhaseRoute({ intent: "review", toAgent: "codex" }).ok, false);
  assert.equal(evaluatePhaseRoute({ intent: "accept", toAgent: "codex" }).ok, true);
  assert.equal(evaluatePhaseRoute({ intent: "discuss", toAgent: "grok" }).ok, true);
  assert.equal(evaluatePhaseRoute({ intent: "discuss", toAgent: "opencode" }).ok, true);
});

test("intent capabilities distinguish roles that share the deliver phase", () => {
  const wrongDelivery = evaluatePhaseRoute({ intent: "deliver", toAgent: "codex" });
  assert.equal(wrongDelivery.ok, false);
  assert.equal(wrongDelivery.reason, "target_lacks_intent_capability");
  assert.deepEqual(wrongDelivery.allowed, ["opencode"]);

  const wrongAcceptance = evaluatePhaseRoute({ intent: "accept", toAgent: "opencode" });
  assert.equal(wrongAcceptance.ok, false);
  assert.equal(wrongAcceptance.reason, "target_lacks_intent_capability");
  assert.deepEqual(wrongAcceptance.allowed, ["codex"]);

  assert.equal(evaluatePhaseRoute({ intent: "plan", toAgent: "grok" }).ok, true);
  assert.equal(evaluatePhaseRoute({ intent: "plan", toAgent: "gemini" }).ok, false);
  assert.equal(
    evaluatePhaseRoute({ intent: "plan", toAgent: "gemini" }).reason,
    "target_lacks_intent_capability"
  );
  assert.equal(evaluatePhaseRoute({ intent: "fix", toAgent: "grok" }).ok, true);
  assert.equal(evaluatePhaseRoute({ intent: "review", toAgent: "opencode" }).ok, true);
});

test("balanced policy rejects routes whose target lacks the requested role capability", () => {
  const decision = decidePolicy({
    mode: "balanced",
    fromAgent: "opencode",
    toAgent: "opencode",
    intent: "accept",
    quality: { hasBlock: true, emptyPacket: false, ok: true, intent: "accept" },
  });

  assert.equal(decision, DECISIONS.REJECT);
});

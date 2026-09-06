const assert = require("node:assert/strict");
const test = require("node:test");

const {
  renderCollaborationRules,
  deriveThreadParticipation,
  buildRosterTable,
  pickExampleTarget,
} = require("../../src/agents/collaboration-rules");
const { AGENTS } = require("../../src/agents/catalog");

test("routing contract is provider-neutral and delegates behavior to the Duty Skill", () => {
  const text = renderCollaborationRules("grok", AGENTS);
  assert.match(text, /<!-- Collaboration Rules -->/);
  assert.match(text, /<!-- \/Collaboration Rules -->/);
  assert.match(text, /无行首 @、无结构化 handoff\.to 时继续由当前 Seat/);
  assert.match(text, /当前 Thread 中可跑的启用席位/);
  assert.match(text, /具体操作步骤以当前 Duty Skill 为准/);
  assert.match(text, /不要为了交接、批准或完成去请求人审批/);
  assert.match(text, /参与历史只作判断依据，不是可路由证明/);
  assert.doesNotMatch(text, /reviewer|implementer|唯一.*交付|固定岗位/i);
});

test("routing contract lists only the supplied enabled Seats", () => {
  const enabled = {
    alpha: { label: "Alpha" },
    beta: { label: "Beta" },
  };
  const text = renderCollaborationRules("alpha", enabled);
  assert.match(text, /@Alpha/);
  assert.match(text, /@Beta/);
  assert.doesNotMatch(text, /@Codex|@Gemini|@Grok|@OpenCode/);
});

test("two-seat and four-seat rosters are different and still provider-neutral", () => {
  const two = renderCollaborationRules("alpha", {
    alpha: { label: "Alpha" },
    beta: { label: "Beta" },
  });
  const four = renderCollaborationRules("alpha", {
    alpha: { label: "Alpha" },
    beta: { label: "Beta" },
    gamma: { label: "Gamma" },
    delta: { label: "Delta" },
  });
  assert.match(two, /@Alpha/);
  assert.match(two, /@Beta/);
  assert.doesNotMatch(two, /@Gamma|@Delta/);
  assert.match(four, /@Gamma/);
  assert.match(four, /@Delta/);
  assert.notEqual(two, four);
  assert.doesNotMatch(two, /reviewer|implementer/i);
  assert.doesNotMatch(four, /reviewer|implementer/i);
});

test("empty bindings still include the current Seat and Duty", () => {
  const participation = deriveThreadParticipation({
    current: {
      seatId: "seat-grok",
      providerId: "grok",
      label: "Grok",
      duty: "plan",
    },
  });
  assert.deepEqual(participation.seats, [
    {
      seatId: "seat-grok",
      providerId: "grok",
      label: "Grok",
      enabled: true,
      duties: ["plan"],
    },
  ]);
  assert.deepEqual(participation.duties, ["plan"]);
  const text = renderCollaborationRules("grok", { grok: { label: "Grok" } }, participation);
  assert.match(text, /本 Thread 已参与：@Grok（grok）〔plan〕/);
  assert.doesNotMatch(text, /本 Thread 已出现 Duty/);
});

test("duties stay unique in first-seen order and remain attached to their Seat", () => {
  const participation = deriveThreadParticipation({
    bindings: [
      { seatId: "seat-a", duty: "discuss" },
      { seatId: "seat-a", duty: "implement" },
      { seatId: "seat-b", duty: "review" },
      { seatId: "seat-a", duty: "implement" },
    ],
    seats: [
      { seatId: "seat-a", providerId: "alpha", label: "Alpha", enabled: true },
      { seatId: "seat-b", providerId: "beta", label: "Beta", enabled: true },
    ],
    current: { seatId: "seat-a", providerId: "alpha", duty: "implement" },
  });
  assert.deepEqual(participation.duties, ["discuss", "implement", "review"]);
  assert.deepEqual(
    participation.seats.map((seat) => ({
      providerId: seat.providerId,
      duties: seat.duties,
    })),
    [
      { providerId: "alpha", duties: ["discuss", "implement"] },
      { providerId: "beta", duties: ["review"] },
    ]
  );
  const text = renderCollaborationRules(
    "alpha",
    { alpha: { label: "Alpha" }, beta: { label: "Beta" } },
    participation
  );
  assert.match(text, /@Alpha（alpha）〔discuss、implement〕/);
  assert.match(text, /@Beta（beta）〔review〕/);
  assert.doesNotMatch(text, /@Alpha（alpha）〔[^〕]*review/);
  assert.doesNotMatch(text, /@Beta（beta）〔[^〕]*implement/);
});

test("disabled seats can appear in history but not in the routable roster", () => {
  const participation = deriveThreadParticipation({
    bindings: [
      { seatId: "seat-alpha", duty: "implement" },
      { seatId: "seat-gamma", duty: "review" },
    ],
    seats: [
      { seatId: "seat-alpha", providerId: "alpha", label: "Alpha", enabled: true },
      { seatId: "seat-gamma", providerId: "gamma", label: "Gamma", enabled: false },
    ],
    current: { seatId: "seat-alpha", providerId: "alpha", label: "Alpha", duty: "implement" },
  });
  assert.equal(
    participation.seats.some((seat) => seat.providerId === "gamma" && seat.enabled === false),
    true
  );
  const text = renderCollaborationRules("alpha", { alpha: { label: "Alpha" } }, participation);
  assert.match(text, /已参与：.*@Gamma（gamma）〔review〕/);
  assert.match(text, /\| @Alpha \| alpha \|/);
  assert.doesNotMatch(text, /\| @Gamma \| gamma \|/);
});

test("same provider with different seatIds stays distinct and keeps Seat-to-Duty pairing", () => {
  const participation = deriveThreadParticipation({
    bindings: [
      { seatId: "seat-a", duty: "implement" },
      { seatId: "seat-b", duty: "review" },
    ],
    seats: [
      { seatId: "seat-a", providerId: "grok", label: "Grok A", enabled: true },
      { seatId: "seat-b", providerId: "grok", label: "Grok B", enabled: true },
    ],
    current: { seatId: "seat-b", providerId: "grok", label: "Grok B", duty: "review" },
  });
  assert.equal(participation.seats.length, 2);
  assert.deepEqual(
    participation.seats.map((seat) => ({
      seatId: seat.seatId,
      label: seat.label,
      duties: seat.duties,
    })),
    [
      { seatId: "seat-a", label: "Grok A", duties: ["implement"] },
      { seatId: "seat-b", label: "Grok B", duties: ["review"] },
    ]
  );
  const text = renderCollaborationRules("grok", { grok: { label: "Grok" } }, participation);
  assert.match(text, /@Grok A（grok）〔implement〕/);
  assert.match(text, /@Grok B（grok）〔review〕/);
  assert.doesNotMatch(text, /@Grok A（grok）〔[^〕]*review/);
});

test("current provider matches an earlier unique seatId without duplicating the roster", () => {
  const participation = deriveThreadParticipation({
    bindings: [{ seatId: "seat-codex", duty: "discuss", invocationId: "inv-1" }],
    seats: [{ seatId: "seat-codex", providerId: "codex", label: "Codex", enabled: true }],
    invocations: [{ id: "inv-1", agentId: "codex" }],
    current: { providerId: "codex", label: "Codex", duty: "discuss" },
  });
  assert.deepEqual(
    participation.seats.map((seat) => ({
      seatId: seat.seatId,
      providerId: seat.providerId,
      duties: seat.duties,
    })),
    [{ seatId: "seat-codex", providerId: "codex", duties: ["discuss"] }]
  );
  assert.deepEqual(participation.duties, ["discuss"]);
});

test("legacy invocations without DutyBinding add seats but never guess duties", () => {
  const participation = deriveThreadParticipation({
    bindings: [],
    invocations: [{ id: "inv-1", agentId: "codex" }],
    seats: [{ seatId: "seat-codex", providerId: "codex", label: "Codex", enabled: true }],
    current: { providerId: "grok", label: "Grok", duty: "plan" },
  });
  assert.deepEqual(
    participation.seats.map((seat) => ({
      providerId: seat.providerId,
      duties: seat.duties,
    })),
    [
      { providerId: "codex", duties: [] },
      { providerId: "grok", duties: ["plan"] },
    ]
  );
  assert.deepEqual(participation.duties, ["plan"]);
  const text = renderCollaborationRules(
    "grok",
    { grok: { label: "Grok" }, codex: { label: "Codex" } },
    participation
  );
  assert.match(text, /@Codex（codex）〔（无 Duty 记录）〕/);
  assert.match(text, /@Grok（grok）〔plan〕/);
});

test("buildRosterTable formats Seat labels and provider keys", () => {
  const table = buildRosterTable({ a: { label: "A" } });
  assert.match(table, /\| @A \| a \|/);
  assert.equal(buildRosterTable({}), "| （仅当前 Seat） | — |");
});

test("pickExampleTarget skips the current Seat and has a neutral fallback", () => {
  const picked = pickExampleTarget("grok", AGENTS);
  assert.notEqual(picked.id, "grok");
  assert.ok(picked.label);
  assert.deepEqual(pickExampleTarget("solo", { solo: { label: "Solo" } }), {
    id: "enabled-seat",
    label: "EnabledSeat",
  });
});

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildDutyBinding,
  initialDuty,
  initializeCatalogSeats,
  resolveEnabledSeat,
} = require("../../src/agents/duty-routing");

test("catalog initialization creates deterministic enabled Seats once", () => {
  const rows = [];
  const repository = {
    listForThread: (threadId) => rows.filter((row) => row.threadId === threadId),
    create: (row) => {
      rows.push({ ...row });
      return { ...row };
    },
  };
  const agents = { codex: { label: "Codex" }, grok: { label: "Grok" } };

  const first = initializeCatalogSeats(repository, "thread-1", agents, {
    createdAt: "2026-09-04T00:00:00.000Z",
  });
  const second = initializeCatalogSeats(repository, "thread-1", agents);

  assert.equal(first.length, 2);
  assert.equal(second.length, 2);
  assert.equal(rows.length, 2);
  assert.match(rows[0].seatId, /^legacy-seat:/);
  assert.equal(
    resolveEnabledSeat(repositoryFor(rows), "thread-1", "Grok", agents).providerId,
    "grok"
  );
});

test("Duty binding records routing reason and provider enforcement capability", () => {
  const seat = { seatId: "seat-grok", providerId: "grok", enabled: true };
  assert.equal(initialDuty({ useWorktree: false }), "discuss");
  assert.equal(initialDuty({ useWorktree: true }), "implement");
  assert.equal(initialDuty({ requestedDuty: "review", useWorktree: true }), "review");

  assert.deepEqual(
    buildDutyBinding({
      seat,
      duty: "fix",
      routingReason: "handoff_to",
      agentConfig: { runtimeCapabilities: { permissionCallbacks: true } },
    }),
    {
      seatId: "seat-grok",
      duty: "fix",
      skillName: "receiving-review",
      routingReason: "handoff_to",
      enforcementLevel: "enforced",
    }
  );
  assert.throws(() => initialDuty({ requestedDuty: "owner" }), /Unsupported duty/);
});

function repositoryFor(rows) {
  return {
    listEnabledForThread: (threadId) =>
      rows.filter((row) => row.threadId === threadId && row.enabled !== false),
  };
}

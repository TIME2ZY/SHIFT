"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { selectDelegationTeam } = require("../../src/agents/delegation-team");
const seats = [
  { seatId: "a", providerId: "alpha", enabled: true },
  { seatId: "b", providerId: "beta", enabled: true },
  { seatId: "disabled", providerId: "disabled", enabled: false },
  { seatId: "unknown-provider", providerId: "missing", enabled: true },
];
test("team excludes disabled and unavailable providers and prefers verified availability", () => {
  const availability = {
    isRoutable: (id) => id !== "disabled",
    get: (id) => ({ status: id === "beta" ? "available" : "unknown" }),
  };
  const team = selectDelegationTeam({
    seats,
    agents: { alpha: {}, beta: {}, disabled: {} },
    availability,
  });
  assert.equal(team.bindings.implement.providerId, "beta");
  assert.equal(team.bindings.review.providerId, "alpha");
  assert.equal(team.members.length, 2);
  assert.equal(team.reviewMode, "independent");
  assert.equal(team.bindings.review.availabilityStatus, "unknown");
  assert.deepEqual(
    selectDelegationTeam({
      seats: [...seats].reverse(),
      agents: { alpha: {}, beta: {} },
      availability,
    }),
    team
  );
});
test("one routable agent explicitly records solo fallback; zero agents fails", () => {
  const team = selectDelegationTeam({ seats: [seats[0]], agents: { alpha: {} } });
  assert.equal(team.reviewMode, "solo_fallback");
  assert.equal(team.bindings.review.routingReason, "solo_fallback");
  assert.equal(team.members[0].availabilityStatus, "unknown");
  assert.throws(
    () => selectDelegationTeam({ seats, agents: {}, availability: { isRoutable: () => false } }),
    { code: "NO_ROUTABLE_SEATS" }
  );
});

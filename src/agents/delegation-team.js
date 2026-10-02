"use strict";
const { SOFTWARE_DUTIES } = require("../shared/delegation-contracts");

function selectDelegationTeam({ seats = [], agents = {}, availability } = {}) {
  const candidates = seats
    .filter(
      (seat) =>
        seat.enabled !== false &&
        agents[seat.providerId] &&
        (!availability || availability.isRoutable(seat.providerId))
    )
    .map((seat) => ({
      ...seat,
      availabilityStatus: availability?.get(seat.providerId)?.status || "unknown",
    }))
    .sort(
      (a, b) =>
        (a.availabilityStatus === "available" ? 0 : 1) -
          (b.availabilityStatus === "available" ? 0 : 1) ||
        a.providerId.localeCompare(b.providerId) ||
        a.seatId.localeCompare(b.seatId)
    );
  if (!candidates.length)
    throw Object.assign(new Error("没有可路由的 Agent，请检查 CLI 安装和登录。"), {
      code: "NO_ROUTABLE_SEATS",
      statusCode: 503,
    });
  const main = candidates[0];
  const reviewer = candidates.find((seat) => seat.providerId !== main.providerId) || main;
  const independent = reviewer.providerId !== main.providerId;
  const bindings = Object.fromEntries(
    SOFTWARE_DUTIES.map((duty) => {
      const seat = ["review", "accept"].includes(duty) ? reviewer : main;
      return [
        duty,
        {
          seatId: seat.seatId,
          providerId: seat.providerId,
          routingReason: duty === "review" && !independent ? "solo_fallback" : "affinity",
          availabilityStatus: seat.availabilityStatus,
        },
      ];
    })
  );
  const members = [
    ...new Map(
      [main, reviewer].map((seat) => [
        seat.seatId,
        {
          seatId: seat.seatId,
          providerId: seat.providerId,
          label: seat.label || agents[seat.providerId].label || seat.providerId,
          availabilityStatus: seat.availabilityStatus,
        },
      ])
    ).values(),
  ];
  return {
    workflowId: "software_delivery",
    bindings,
    members,
    reviewMode: independent ? "independent" : "solo_fallback",
  };
}
module.exports = { selectDelegationTeam };

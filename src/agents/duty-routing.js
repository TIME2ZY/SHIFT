"use strict";

const { DUTIES } = require("../shared/collab-contracts");
const { legacySeatId } = require("../shared/seat-contracts");

const DUTY_SKILLS = Object.freeze({
  discuss: "solution-baseline-acceptance",
  plan: "implementation-plan",
  implement: "implementation-plan",
  fix: "implementation-plan",
  review: "code-review-deliver",
  deliver: "code-review-deliver",
  accept: "solution-baseline-acceptance",
  recall: "memory-write",
});

function initializeCatalogSeats(repository, threadId, agents, options = {}) {
  if (!repository || typeof repository.create !== "function") return [];
  const existing = repository.listForThread(threadId);
  const byProvider = new Set(existing.map((seat) => seat.providerId));
  const created = [];
  const now = options.createdAt || new Date().toISOString();
  for (const [providerId, profile] of Object.entries(agents || {})) {
    const normalized = normalizeProviderId(providerId);
    if (!normalized || byProvider.has(normalized)) continue;
    created.push(
      repository.create({
        seatId: legacySeatId(threadId, normalized),
        threadId,
        providerId: normalized,
        label: profile?.label || null,
        enabled: true,
        affinityTags: [],
        createdAt: now,
      })
    );
    byProvider.add(normalized);
  }
  return [...existing, ...created];
}

function resolveEnabledSeat(repository, threadId, target, agents = {}) {
  if (!repository || typeof repository.listEnabledForThread !== "function") return null;
  const needle = String(target || "")
    .trim()
    .toLowerCase();
  if (!needle) return null;
  return (
    repository.listEnabledForThread(threadId).find((seat) => {
      const profile = agents[seat.providerId] || {};
      return [seat.seatId, seat.providerId, seat.label, profile.label]
        .filter(Boolean)
        .some((value) => String(value).trim().toLowerCase() === needle);
    }) || null
  );
}

function buildDutyBinding({ seat, duty, routingReason, agentConfig }) {
  if (!seat) return null;
  const normalizedDuty = normalizeDuty(duty);
  return {
    seatId: seat.seatId,
    duty: normalizedDuty,
    skillName: DUTY_SKILLS[normalizedDuty],
    routingReason,
    enforcementLevel: resolveEnforcementLevel(agentConfig, normalizedDuty),
  };
}

function initialDuty({ requestedDuty, useWorktree = false } = {}) {
  if (requestedDuty !== undefined && requestedDuty !== null && requestedDuty !== "") {
    return normalizeDuty(requestedDuty);
  }
  return useWorktree ? "implement" : "discuss";
}

function normalizeDuty(value, fallback = "discuss") {
  const duty = String(value || fallback)
    .trim()
    .toLowerCase();
  if (!DUTIES.includes(duty)) throw new Error(`Unsupported duty: ${duty || "(missing)"}`);
  return duty;
}

function resolveEnforcementLevel(agentConfig, duty) {
  const permissionCallbacks = agentConfig?.runtimeCapabilities?.permissionCallbacks === true;
  return permissionCallbacks && ["plan", "implement", "fix"].includes(duty)
    ? "enforced"
    : "advisory";
}

function activeSkillNames(binding) {
  if (!binding?.skillName) return ["cross-agent-handoff"];
  return [...new Set([binding.skillName, "cross-agent-handoff"])];
}

function normalizeProviderId(value) {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "";
}

module.exports = {
  DUTY_SKILLS,
  initializeCatalogSeats,
  resolveEnabledSeat,
  buildDutyBinding,
  initialDuty,
  normalizeDuty,
  resolveEnforcementLevel,
  activeSkillNames,
};

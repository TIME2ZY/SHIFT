"use strict";
const { getProviderAdapter } = require("./providers");
const { READ_ONLY_PLANNERS } = require("./preparation-permissions");
function createAgentCatalog({ agents = {}, availability } = {}) {
  function list() {
    return Object.entries(agents)
      .map(([id, config]) => ({
        id,
        label: config.label || id,
        capabilities: [
          ...(getProviderAdapter(config.providerId || id).capabilities.tools ? ["software"] : []),
          ...(READ_ONLY_PLANNERS.includes(config.providerId || id) ? ["read_only_planning"] : []),
        ],
        capabilitySource: "provider_adapter",
        availabilityStatus: availability?.get(id)?.status || "unknown",
        routable: !availability || availability.isRoutable(id),
      }))
      .sort(
        (a, b) =>
          (a.availabilityStatus === "available" ? 0 : 1) -
            (b.availabilityStatus === "available" ? 0 : 1) || a.id.localeCompare(b.id)
      );
  }
  function candidates(capabilities) {
    const found = list().filter(
      (agent) =>
        agent.routable &&
        capabilities.every((capability) => agent.capabilities.includes(capability))
    );
    if (!found.length)
      throw Object.assign(new Error("没有满足能力要求的可用 Agent：" + capabilities.join("、")), {
        code: "NO_CAPABLE_AGENT",
        statusCode: 503,
      });
    return found;
  }
  return { list, candidates };
}
module.exports = { createAgentCatalog };

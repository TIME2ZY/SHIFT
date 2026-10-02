"use strict";
function createTeamCatalog({ definitions, agents }) {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  if (byId.size !== definitions.length) throw new Error("Duplicate Team definition.");
  function requireDefinition(id) {
    const definition = byId.get(id);
    if (!definition)
      throw Object.assign(new Error("未支持的团队流程：" + id), {
        code: "UNSUPPORTED_WORKFLOW",
        statusCode: 400,
      });
    return definition;
  }
  return {
    list: () =>
      definitions.map(({ id, description, capabilities }) => ({ id, description, capabilities })),
    select(node) {
      const definition = requireDefinition(node.workflowId);
      if (node.capabilities.some((capability) => !definition.capabilities.includes(capability)))
        throw Object.assign(new Error("团队无法满足分任务能力要求。"), {
          code: "UNSUPPORTED_CAPABILITY",
          statusCode: 400,
        });
      const bindings = {},
        members = new Map();
      for (const role of definition.roles) {
        const candidates = agents.candidates([...node.capabilities, ...(role.capabilities || [])]);
        const chosen = role.independent
          ? candidates.find(
              (candidate) => candidate.id !== bindings[definition.roles[0].id]?.providerId
            ) || candidates[0]
          : candidates[0];
        const independent =
          role.independent && chosen.id !== bindings[definition.roles[0].id]?.providerId;
        const member = {
          providerId: chosen.id,
          label: chosen.label,
          availabilityStatus: chosen.availabilityStatus,
        };
        members.set(chosen.id, member);
        bindings[role.id] = {
          ...member,
          routingReason: role.independent
            ? independent
              ? "independent"
              : "solo_fallback"
            : "capability_match",
        };
      }
      return { workflowId: definition.id, bindings, members: [...members.values()] };
    },
    execute(claim, context) {
      return requireDefinition(claim.node.workflowId).execute(claim, context);
    },
  };
}
module.exports = { createTeamCatalog };

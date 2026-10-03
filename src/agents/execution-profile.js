"use strict";
function resolveExecutionProfile({ body, storage, sessionId, agentId }) {
  if (body.internalPurpose === "prepare")
    return {
      purpose: "prepare",
      software: false,
      workflowId: "task_preparation",
      roleId: "plan",
      routingReason: "capability_match",
    };
  const binding = storage?.tasks?.findRunByThread(sessionId);
  if (
    body.internalPurpose === "team" &&
    binding?.state === "running" &&
    binding.workflowId === "software_delivery"
  )
    return { purpose: "execute", software: true };
  if (
    body.internalPurpose === "materials" &&
    binding?.state === "running" &&
    binding.workflowId === "materials_analysis"
  ) {
    const member = binding.team.bindings[body.internalRole];
    if (member?.providerId === agentId && !body.useWorktree)
      return {
        purpose: "materials",
        software: false,
        workflowId: binding.workflowId,
        roleId: body.internalRole,
        routingReason:
          member.routingReason === "solo_fallback" ? "solo_fallback" : "capability_match",
      };
  }
  throw Object.assign(new Error("调用未绑定到有效的任务执行流程。"), {
    statusCode: 409,
    code: "INVALID_EXECUTION_PROFILE",
  });
}
module.exports = { resolveExecutionProfile };

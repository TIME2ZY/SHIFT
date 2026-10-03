"use strict";
const READ_ONLY_PLANNERS = Object.freeze(["codex", "claude"]);
function applyPreparationPermissions(config, env = process.env) {
  if (env.INVOKE_PURPOSE !== "prepare") return config;
  if (!READ_ONLY_PLANNERS.includes(config.providerId))
    throw new Error("This Provider cannot enforce read-only delegation preparation.");
  return {
    ...config,
    preparationOnly: true,
    resumeSessionId: undefined,
    providerOptions: {
      ...(config.providerOptions || {}),
      sandbox: "read-only",
      approvalPolicy: "never",
    },
  };
}
module.exports = { READ_ONLY_PLANNERS, applyPreparationPermissions };

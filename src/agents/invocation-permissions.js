"use strict";
const READ_ONLY_PROVIDERS = Object.freeze(["codex", "claude"]);
function applyReadOnlyPermissions(config, env = process.env) {
  if (!["prepare", "materials"].includes(env.INVOKE_PURPOSE)) return config;
  if (!READ_ONLY_PROVIDERS.includes(config.providerId))
    throw new Error("This Provider cannot enforce read-only task invocation.");
  return {
    ...config,
    readOnlyInvocation: true,
    resumeSessionId: undefined,
    providerOptions: {
      ...(config.providerOptions || {}),
      sandbox: "read-only",
      approvalPolicy: "never",
    },
  };
}
module.exports = { READ_ONLY_PROVIDERS, applyReadOnlyPermissions };

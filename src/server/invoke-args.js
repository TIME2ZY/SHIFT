const path = require("node:path");

function createInvokeArgsBuilder({ agents, runnerPath }) {
  if (typeof runnerPath !== "string" || !path.isAbsolute(runnerPath)) {
    throw new Error("Agent runner path must be absolute.");
  }

  function buildInvokeArgs(body, augmentedPrompt) {
    const agent = typeof body.agent === "string" ? body.agent : "codex";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

    if (!agents[agent]) throw new Error(`Unsupported agent "${agent}".`);
    if (!prompt) throw new Error("Prompt is required.");

    const args = [runnerPath, "--agent", agent];
    args.push(augmentedPrompt || prompt);
    return args;
  }

  function buildChatArgs(agent, prompt, augmentedPrompt) {
    return buildInvokeArgs({ agent, prompt }, augmentedPrompt);
  }

  return { buildInvokeArgs, buildChatArgs };
}

module.exports = { createInvokeArgsBuilder };

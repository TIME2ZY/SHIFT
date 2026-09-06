const { AGENTS } = require("./catalog");

const DEFAULT_MAX_A2A_DEPTH = 15;

/**
 * Parse @mentions from agent output text.
 *
 * Rules (from cat-cafe-tutorials lesson 04):
 * 1. Strip code blocks first — prevent false triggers from code examples
 * 2. Line-start strict matching — agent must actively "call out" another agent
 * 3. Filter self — an agent cannot @ itself
 *
 * @param {string} text — full output text from the agent
 * @param {string} currentAgentId — the agent that produced this text
 * @returns {string[]} agent IDs mentioned (e.g. ["sage", "reviewer"])
 */
function parseA2AMentions(text, currentAgentId, agents = AGENTS) {
  if (!text || typeof text !== "string") return [];

  // Step 1: Strip fenced code blocks (backtick and tilde)
  // This prevents @mentions inside code examples from triggering routing
  const stripped = text.replace(/```[\s\S]*?```/g, "").replace(/~~~[\s\S]*?~~~/g, "");

  // Step 2: Line-start matching for each agent's id and label
  // Frontend allows users to mention either @id or @label; agents may also
  // use either form, so we must route both consistently.
  const mentions = new Set();

  for (const [id, config] of Object.entries(agents)) {
    if (id === currentAgentId) continue; // Rule 3: can't @ yourself

    const candidates = new Set([id, config.label].filter(Boolean));
    for (const candidate of candidates) {
      const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Match `@Candidate` at start of a line (with optional leading whitespace)
      // Use (?!\\S) instead of \\b — \\b doesn't work with CJK characters
      const pattern = new RegExp(`^\\s*@${escaped}(?!\\S)`, "mi");

      if (pattern.test(stripped)) {
        mentions.add(id);
        break;
      }
    }
  }

  // Cap routed agents per turn to avoid fan-out explosions.
  return [...mentions].slice(0, 2);
}

/**
 * Read max A2A depth from env, with a safe default.
 * Prevents infinite @mention chains.
 */
function getMaxA2ADepth() {
  const env = Number(process.env.MAX_A2A_DEPTH);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_MAX_A2A_DEPTH;
}

module.exports = {
  parseA2AMentions,
  getMaxA2ADepth,
};

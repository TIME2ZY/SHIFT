const fs = require("node:fs");
const path = require("node:path");
const { parseSkillFrontmatter } = require("../shared/frontmatter");

const DEFAULT_IDENTITIES_DIR = path.join(__dirname, "identities");

/** @type {Map<string, IdentityRecord> | null} */
let cache = null;

/**
 * @typedef {object} IdentityRecord
 * @property {string} id
 * @property {string} label
 * @property {string} role
 * @property {string[]} duties
 * @property {string[]} boundaries
 * @property {string} body
 * @property {string} file
 */

/**
 * Load all identity markdown files from a directory.
 * @param {string} [dir]
 * @returns {Map<string, IdentityRecord>}
 */
function loadIdentities(dir = DEFAULT_IDENTITIES_DIR) {
  const map = new Map();
  if (!fs.existsSync(dir)) return map;

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file), "utf8");
    const parsed = parseSkillFrontmatter(content);
    if (!parsed) continue;

    const id = String(parsed.meta.id || file.replace(/\.md$/, "")).trim();
    if (!id) continue;
    map.set(id, {
      id,
      label: String(parsed.meta.label || id),
      role: String(parsed.meta.role || ""),
      duties: asStringArray(parsed.meta.duties),
      boundaries: asStringArray(parsed.meta.boundaries),
      body: parsed.body || "",
      file,
    });
  }

  return map;
}

function asStringArray(value) {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function getCache() {
  if (!cache) cache = loadIdentities(DEFAULT_IDENTITIES_DIR);
  return cache;
}

function resetIdentityCache() {
  cache = null;
}

/**
 * @param {string} agentId
 * @returns {IdentityRecord | null}
 */
function getIdentity(agentId) {
  if (!agentId) return null;
  return getCache().get(agentId) || null;
}

/**
 * Build a fallback identity block when no markdown file exists.
 * @param {string} agentId
 * @param {{ label?: string, description?: string } | null} [fallback]
 */
function renderFallbackIdentityBlock(agentId, fallback = null) {
  const label = (fallback && fallback.label) || agentId || "unknown";
  const description = (fallback && fallback.description) || "";
  const lines = [
    `<!-- Agent Identity: ${agentId || "unknown"} / ${label} -->`,
    `# 你是谁`,
    ``,
    `你是 **${label}**（id: \`${agentId || "unknown"}\`）。`,
  ];
  if (description) {
    lines.push(``, description);
  }
  lines.push(`<!-- /Agent Identity -->`, ``);
  return lines.join("\n");
}

/**
 * Render the full identity prompt block for an agent.
 * Injected at the start of every invocation (including A2A handoffs).
 *
 * @param {string} agentId
 * @param {{ label?: string, description?: string } | null} [fallback] catalog entry for unknown ids
 * @returns {string}
 */
function renderIdentityBlock(agentId, fallback = null) {
  const identity = getIdentity(agentId);
  if (!identity) {
    return renderFallbackIdentityBlock(agentId, fallback);
  }

  const label = identity.label || agentId;
  const lines = [`<!-- Agent Identity: ${identity.id} / ${label} -->`];

  if (identity.role) {
    lines.push(`Role: ${identity.role}`);
  }
  if (identity.duties.length > 0) {
    lines.push(`Duties: ${identity.duties.join("；")}`);
  }
  if (identity.boundaries.length > 0) {
    lines.push(`Boundaries: ${identity.boundaries.join("；")}`);
  }
  if (identity.role || identity.duties.length > 0 || identity.boundaries.length > 0) {
    lines.push("");
  }

  lines.push(identity.body.trim(), `<!-- /Agent Identity -->`, "");
  return lines.join("\n");
}

/**
 * Public metadata for UI / API (no full body).
 * @returns {Array<{ id: string, label: string, role: string, duties: string[], boundaries: string[] }>}
 */
function publicIdentities() {
  return [...getCache().values()].map((id) => ({
    id: id.id,
    label: id.label,
    role: id.role,
    duties: id.duties.slice(),
    boundaries: id.boundaries.slice(),
  }));
}

/**
 * Warn (or throw in strict mode) when catalog agents lack identity files.
 * @param {string[]} agentIds
 * @param {{ strict?: boolean }} [opts]
 * @returns {string[]} missing ids
 */
function assertIdentitiesForAgents(agentIds, opts = {}) {
  const missing = [];
  for (const id of agentIds) {
    if (!getIdentity(id)) missing.push(id);
  }
  if (missing.length > 0) {
    const msg = `Missing agent identity files for: ${missing.join(", ")} (expected under src/agents/identities/)`;
    if (opts.strict) throw new Error(msg);
    console.warn(`[identity] ${msg}`);
  }
  return missing;
}

module.exports = {
  DEFAULT_IDENTITIES_DIR,
  loadIdentities,
  getIdentity,
  renderIdentityBlock,
  renderFallbackIdentityBlock,
  publicIdentities,
  assertIdentitiesForAgents,
  resetIdentityCache,
};

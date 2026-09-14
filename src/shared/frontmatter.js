/**
 * Minimal YAML-like frontmatter parser shared by skills and agent identities.
 * Returns { meta: {}, body: "..." } or null if no frontmatter found.
 */
function parseSkillFrontmatter(content) {
  const match = String(content || "").match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return null;

  const rawMeta = match[1];
  const body = match[2].trim();
  const meta = {};
  let currentArrayKey = null;

  for (const line of rawMeta.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // YAML list item: "- value" or "- "value""
    if (trimmed.startsWith("- ") && currentArrayKey) {
      const item = trimmed
        .slice(2)
        .trim()
        .replace(/^["']|["']$/g, "");
      meta[currentArrayKey].push(item);
      continue;
    }

    // Key-only (start of a YAML list block): "key:"
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();

    // Key with no value → might start a YAML list block
    if (value === "") {
      meta[key] = [];
      currentArrayKey = key;
      continue;
    }

    // Key with value → reset list context
    currentArrayKey = null;

    // Boolean
    if (value === "true") {
      meta[key] = true;
      continue;
    }
    if (value === "false") {
      meta[key] = false;
      continue;
    }

    // JSON-style array: [item1, item2]
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1);
      meta[key] = inner ? inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")) : [];
      continue;
    }

    // String (strip optional quotes)
    meta[key] = value.replace(/^["']|["']$/g, "");
  }

  return { meta, body };
}

module.exports = {
  parseSkillFrontmatter,
  // Alias for non-skill callers (identities, etc.)
  parseFrontmatter: parseSkillFrontmatter,
};

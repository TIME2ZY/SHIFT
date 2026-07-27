/**
 * Canonical topic aliases for product memories.
 * Write path normalizes free-form topics so supersession keys stay stable.
 * (Does not import memory-keys — avoids circular dependency with slugify.)
 */

/** alias (already slugified) → canonical topic */
const TOPIC_ALIASES = Object.freeze({
  // auth / session
  "auth-session-ttl": "auth-token-ttl",
  "auth-token-ttl": "auth-token-ttl",
  "token-ttl": "auth-token-ttl",
  "access-token-ttl": "auth-token-ttl",
  "auth-no-refresh-token": "auth-no-refresh",
  "auth-no-refresh": "auth-no-refresh",
  "no-refresh-token": "auth-no-refresh",
  "auth-password-hash": "auth-password-hash",
  "password-hash": "auth-password-hash",
  "auth-session-model": "auth-session-model",
  "auth-login-api": "auth-login-contract",
  "auth-login-contract": "auth-login-contract",
  "auth-phase-scope": "auth-scope",
  "auth-scope": "auth-scope",
  "auth-token-isolation": "auth-token-isolation",
  "auth-callback-token-isolation": "auth-token-isolation",
  // storage / runtime
  "storage-primary": "storage-primary",
  "dev-port": "local-dev-port",
  "local-dev-port": "local-dev-port",
  "port-8787": "local-dev-port",
});

/**
 * Lightweight slug for alias lookup (mirrors memory-keys.slugifyTopic).
 * @param {string} value
 */
function slugForCanon(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_/\\]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!raw) throw new Error("Memory topic is required.");
  return raw.slice(0, 80);
}

/**
 * @param {string} topic
 * @returns {string} canonical slug
 */
function canonicalizeTopic(topic) {
  const slug = slugForCanon(topic);
  return TOPIC_ALIASES[slug] || slug;
}

/**
 * Human-facing list for skills / callback docs.
 */
function listCanonicalTopics() {
  const set = new Set(Object.values(TOPIC_ALIASES));
  return [...set].sort();
}

module.exports = {
  TOPIC_ALIASES,
  canonicalizeTopic,
  listCanonicalTopics,
};

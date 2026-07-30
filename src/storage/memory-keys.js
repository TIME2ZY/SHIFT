/**
 * Stable L3 topic keys for product memories.
 *
 * Examples:
 *   decision:storage-primary
 *   constraint:chat-fail-open
 *   fact:runtime-database
 */

const PRODUCT_KINDS = Object.freeze(["decision", "constraint", "fact"]);
const AUTO_KINDS = Object.freeze([]);
const ALL_KINDS = Object.freeze([...PRODUCT_KINDS, ...AUTO_KINDS]);
const ACTIVE_STATUSES = Object.freeze(["active"]);
const ALL_STATUSES = Object.freeze(["active", "superseded"]);

function isProductKind(kind) {
  return PRODUCT_KINDS.includes(kind);
}

function normalizeProductKind(value) {
  if (typeof value !== "string" || !PRODUCT_KINDS.includes(value)) {
    throw new Error(`Memory kind must be one of: ${PRODUCT_KINDS.join(", ")}.`);
  }
  return value;
}

/**
 * Normalize a free-form topic into a stable key segment.
 * Keeps Chinese/letters/digits; collapses other runs to single hyphens.
 */
function slugifyTopic(value) {
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

function buildSupersessionKey(kind, topic) {
  const normalizedKind = normalizeProductKind(kind);
  const slug = slugifyTopic(topic);
  return `${normalizedKind}:${slug}`;
}

function parseSupersessionKey(value) {
  if (typeof value !== "string" || !value.includes(":")) return null;
  const separator = value.indexOf(":");
  const kind = value.slice(0, separator);
  const topic = value.slice(separator + 1);
  if (!ALL_KINDS.includes(kind) || !topic) return null;
  return { kind, topic };
}

function buildProductCaptureKey(kind, topic, idFactory) {
  const supersessionKey = buildSupersessionKey(kind, topic);
  const unique =
    typeof idFactory === "function" ? String(idFactory()).replace(/-/g, "").slice(0, 12) : String(Date.now());
  return `product:${supersessionKey}:${unique}`;
}

function deriveTopicFromContent(content) {
  const firstLine = String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) throw new Error("Memory content is required to derive a topic.");
  return slugifyTopic(firstLine.slice(0, 48));
}

const { canonicalizeTopic, listCanonicalTopics, TOPIC_ALIASES } = require("./memory-topic-canon");

module.exports = {
  PRODUCT_KINDS,
  AUTO_KINDS,
  ALL_KINDS,
  ACTIVE_STATUSES,
  ALL_STATUSES,
  TOPIC_ALIASES,
  canonicalizeTopic,
  listCanonicalTopics,
  isProductKind,
  normalizeProductKind,
  slugifyTopic,
  buildSupersessionKey,
  parseSupersessionKey,
  buildProductCaptureKey,
  deriveTopicFromContent,
};

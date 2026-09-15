const path = require("node:path");

const OPAQUE_ID_RE = /^[a-zA-Z0-9_-]{1,200}$/;
const RESERVED_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isValidOpaqueId(value) {
  return typeof value === "string" && OPAQUE_ID_RE.test(value) && !RESERVED_OBJECT_KEYS.has(value);
}

function assertValidOpaqueId(value, label = "id") {
  if (!isValidOpaqueId(value)) {
    throw new Error(`${label} must contain only letters, numbers, underscores, and hyphens.`);
  }
  return value;
}

function resolveInside(rootDir, ...segments) {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, ...segments);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Resolved path escapes its configured root.");
  }
  return target;
}

module.exports = {
  OPAQUE_ID_RE,
  RESERVED_OBJECT_KEYS,
  isValidOpaqueId,
  assertValidOpaqueId,
  resolveInside,
};

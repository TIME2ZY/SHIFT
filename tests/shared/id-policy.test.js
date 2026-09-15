const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const policy = require("../../src/shared/id-policy");

test("opaque IDs accept generated session forms and reject path syntax", () => {
  assert.equal(
    policy.assertValidOpaqueId("1783002404316-mhkj90", "sessionId"),
    "1783002404316-mhkj90"
  );
  for (const value of [
    ".",
    "..",
    "../x",
    "..\\x",
    "a/b",
    "a:b",
    "含中文",
    "__proto__",
    "prototype",
    "constructor",
  ]) {
    assert.throws(() => policy.assertValidOpaqueId(value, "sessionId"), /sessionId/);
  }
});

test("resolveInside refuses paths that resolve outside the configured root", () => {
  const root = path.join(os.tmpdir(), "id-policy-root");
  assert.equal(
    policy.resolveInside(root, "session-1", "sessions.json"),
    path.join(root, "session-1", "sessions.json")
  );
  assert.throws(() => policy.resolveInside(root, "..", "outside.json"), /escapes/);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseSkillFrontmatter } = require("../../src/shared/frontmatter");

test("parseSkillFrontmatter extracts meta and body", () => {
  const parsed = parseSkillFrontmatter(
    [
      "---",
      'name: "demo"',
      "triggers:",
      "- foo",
      "- bar",
      "always: false",
      "---",
      "",
      "Hello body",
    ].join("\n")
  );
  assert.ok(parsed);
  assert.equal(parsed.meta.name, "demo");
  assert.deepEqual(parsed.meta.triggers, ["foo", "bar"]);
  assert.equal(parsed.meta.always, false);
  assert.equal(parsed.body, "Hello body");
});

test("identity layer does not import server modules", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "../../src/agents/identity.js"), "utf8");
  assert.doesNotMatch(source, /require\(["']\.\.\/server\//);
  assert.match(source, /shared\/frontmatter/);
});

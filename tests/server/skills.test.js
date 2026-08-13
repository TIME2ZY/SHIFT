const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  parseSkillFrontmatter,
  matchSkills,
  buildAugmentedPrompt,
  createSkillsService,
  READONLY_MODE_RULE,
} = require("../../src/server/skills");

test("parseSkillFrontmatter reads name triggers and body", () => {
  const parsed = parseSkillFrontmatter(`---
name: demo
description: d
triggers:
  - foo
  - bar
always: false
---
# Body

hello
`);
  assert.equal(parsed.meta.name, "demo");
  assert.deepEqual(parsed.meta.triggers, ["foo", "bar"]);
  assert.match(parsed.body, /hello/);
});

test("matchSkills includes always-on and trigger hits", () => {
  const skills = [
    { name: "always", always: true, triggers: [] },
    { name: "hit", always: false, triggers: ["review"] },
    { name: "miss", always: false, triggers: ["deploy"] },
  ];
  const matched = matchSkills("please review this", skills).map((s) => s.name);
  assert.deepEqual(matched, ["always", "hit"]);
});

test("buildAugmentedPrompt prepends skill blocks", () => {
  const result = buildAugmentedPrompt("user ask", [
    { name: "s1", body: "rule-one" },
  ]);
  assert.match(result.augmentedPrompt, /APPLICATION SKILL: s1/);
  assert.match(result.augmentedPrompt, /rule-one/);
  assert.match(result.augmentedPrompt, /user ask/);
  assert.deepEqual(result.skillNames, ["s1"]);
});

test("createSkillsService loads dir and applies readonly rule", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-"));
  fs.writeFileSync(
    path.join(dir, "x.md"),
    `---
name: x
triggers: [hello]
---
body-x
`
  );
  const service = createSkillsService({ skillsDir: dir });
  assert.equal(service.publicSkills().length, 1);
  const withWt = service.augmentPrompt("hello world", true);
  assert.match(withWt.augmentedPrompt, /body-x/);
  assert.doesNotMatch(withWt.augmentedPrompt, /只读模式/);

  const readonly = service.augmentPrompt("hello world", false);
  assert.match(readonly.augmentedPrompt, /只读模式/);
  assert.ok(READONLY_MODE_RULE.includes("只读模式"));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("augmentPrompt skillNames injects an explicit allow-list", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-names-"));
  fs.writeFileSync(
    path.join(dir, "r.md"),
    `---
name: receiving-review
triggers: [review]
---
recv-body
`
  );
  fs.writeFileSync(
    path.join(dir, "o.md"),
    `---
name: other
triggers: [x]
---
other-body
`
  );
  const service = createSkillsService({ skillsDir: dir });
  const none = service.augmentPrompt("task", true, { skillNames: [] });
  assert.deepEqual(none.skillNames, []);
  assert.equal(none.augmentedPrompt, "task");

  const only = service.augmentPrompt("task", true, { skillNames: ["receiving-review"] });
  assert.deepEqual(only.skillNames, ["receiving-review"]);
  assert.match(only.augmentedPrompt, /recv-body/);
  assert.doesNotMatch(only.augmentedPrompt, /other-body/);

  fs.rmSync(dir, { recursive: true, force: true });
});

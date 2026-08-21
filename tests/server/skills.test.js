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
  loadSkills,
  DEFAULT_SKILLS_DIR,
  READONLY_MODE_RULE,
} = require("../../src/server/skills");

function writeSkill(dir, name, markdown) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "SKILL.md"), markdown, "utf8");
}

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
  const result = buildAugmentedPrompt("user ask", [{ name: "s1", body: "rule-one" }]);
  assert.match(result.augmentedPrompt, /APPLICATION SKILL: s1/);
  assert.match(result.augmentedPrompt, /rule-one/);
  assert.match(result.augmentedPrompt, /user ask/);
  assert.deepEqual(result.skillNames, ["s1"]);
});

test("loadSkills reads directory SKILL.md layout and ignores leftovers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-layout-"));
  try {
    writeSkill(
      dir,
      "demo",
      `---
name: demo
description: d
triggers: [hello]
---
body-demo
`
    );
    fs.writeFileSync(
      path.join(dir, "flat.md"),
      `---
name: flat
---
should-not-load
`
    );
    fs.mkdirSync(path.join(dir, "empty-dir"));
    writeSkill(
      dir,
      "mismatch",
      `---
name: other
---
wrong-name
`
    );

    const loaded = loadSkills(dir);
    assert.deepEqual(
      loaded.map((s) => s.name),
      ["demo"]
    );
    assert.equal(loaded[0].path, "skills/demo/SKILL.md");
    assert.equal(loaded[0].sourceDir, path.join(dir, "demo"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("repo skills load from skills/*/SKILL.md", () => {
  const loaded = loadSkills(DEFAULT_SKILLS_DIR);
  assert.deepEqual(
    loaded.map((s) => s.name),
    [
      "a2a-handoff",
      "code-review-deliver",
      "cross-agent-handoff",
      "implementation-plan",
      "memory-write",
      "merge-approval-gate",
      "receiving-review",
      "requesting-review",
      "solution-baseline-acceptance",
      "uncertainty-ask",
    ]
  );
  assert.ok(loaded.every((skill) => skill.path === `skills/${skill.name}/SKILL.md`));
  assert.equal(
    loaded.some((skill) => skill.path.endsWith(".md") && !skill.path.endsWith("SKILL.md")),
    false
  );
});

test("createSkillsService loads dir, indexes skills, and applies readonly rule", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-"));
  try {
    writeSkill(
      dir,
      "x",
      `---
name: x
description: example
triggers: [hello]
---
body-x
`
    );
    const service = createSkillsService({ skillsDir: dir });
    assert.equal(service.publicSkills().length, 1);
    assert.equal(service.publicSkills()[0].path, "skills/x/SKILL.md");
    assert.deepEqual(service.listSkillIndex(), [{ name: "x", description: "example" }]);
    assert.equal(service.getSkillByName("x").body.includes("body-x"), true);
    assert.equal(service.getSkillByName("../x"), null);
    assert.equal(service.getSkillByName("missing"), null);
    assert.equal(service.getSkillsRoot(), dir);

    const withWt = service.augmentPrompt("hello world", true);
    assert.match(withWt.augmentedPrompt, /body-x/);
    assert.doesNotMatch(withWt.augmentedPrompt, /只读模式/);

    const readonly = service.augmentPrompt("hello world", false);
    assert.match(readonly.augmentedPrompt, /只读模式/);
    assert.ok(READONLY_MODE_RULE.includes("只读模式"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("augmentPrompt skillNames injects an explicit allow-list", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-names-"));
  try {
    writeSkill(
      dir,
      "receiving-review",
      `---
name: receiving-review
triggers: [review]
---
recv-body
`
    );
    writeSkill(
      dir,
      "other",
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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prepareSkillDelivery uses catalog when materialize succeeds and falls back otherwise", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-deliver-"));
  try {
    writeSkill(
      dir,
      "always-on",
      `---
name: always-on
description: always
always: true
---
ALWAYS-BODY
`
    );
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-ws-"));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-proj-"));
    const native = createSkillsService({
      skillsDir: dir,
      materializePlatformSkills: () => ({
        ok: true,
        method: "copy",
        targets: [path.join(workspaceDir, ".agents", "skills", "always-on")],
        errors: [],
      }),
    }).prepareSkillDelivery({
      workspaceDir,
      projectDir,
      useWorktree: true,
      isolated: true,
      rawPrompt: "hello",
    });
    assert.equal(native.nativeDelivery, true);
    assert.deepEqual(native.skillNames, ["always-on"]);
    assert.match(native.augmentedPrompt, /PLATFORM SKILL CATALOG/);
    assert.doesNotMatch(native.augmentedPrompt, /APPLICATION SKILL/);
    assert.doesNotMatch(native.augmentedPrompt, /ALWAYS-BODY/);

    const failed = createSkillsService({
      skillsDir: dir,
      materializePlatformSkills: () => ({
        ok: false,
        method: "copy",
        targets: [],
        errors: ["disk full"],
      }),
    }).prepareSkillDelivery({
      workspaceDir,
      projectDir,
      useWorktree: true,
      isolated: true,
      rawPrompt: "hello",
    });
    assert.equal(failed.nativeDelivery, false);
    assert.match(failed.augmentedPrompt, /APPLICATION SKILL: always-on/);
    assert.match(failed.augmentedPrompt, /ALWAYS-BODY/);

    const sameDir = createSkillsService({ skillsDir: dir }).prepareSkillDelivery({
      workspaceDir: projectDir,
      projectDir,
      useWorktree: true,
      isolated: true,
      rawPrompt: "hello",
    });
    assert.equal(sameDir.nativeDelivery, false);
    assert.equal(sameDir.materialize.skipped, "not-isolated");
    assert.match(sameDir.augmentedPrompt, /ALWAYS-BODY/);

    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

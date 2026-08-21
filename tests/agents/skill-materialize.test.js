const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  materializePlatformSkills,
  resetMaterializeCache,
  isInside,
} = require("../../src/agents/skill-materialize");

function writeSkill(root, name, body = "body") {
  const sourceDir = path.join(root, name);
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, "SKILL.md"),
    `---
name: ${name}
description: ${name}
---
${body}
`,
    "utf8"
  );
  return sourceDir;
}

test("materialize copies skills into isolated workspace discovery path", () => {
  resetMaterializeCache();
  const skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mat-skills-"));
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "mat-ws-"));
  try {
    const sourceDir = writeSkill(skillsRoot, "demo", "copied-body");
    const result = materializePlatformSkills({
      workspaceDir,
      isolated: true,
      skillsRoot,
      entries: [{ name: "demo", sourceDir }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.method, "copy");
    const skillFile = path.join(workspaceDir, ".agents", "skills", "demo", "SKILL.md");
    assert.equal(fs.existsSync(skillFile), true);
    assert.match(fs.readFileSync(skillFile, "utf8"), /copied-body/);
    assert.equal(
      fs.lstatSync(path.join(workspaceDir, ".agents", "skills", "demo")).isSymbolicLink(),
      false
    );
  } finally {
    fs.rmSync(skillsRoot, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("materialize is idempotent for the same workspace", () => {
  resetMaterializeCache();
  const skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mat-skills-id-"));
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "mat-ws-id-"));
  try {
    const sourceDir = writeSkill(skillsRoot, "demo", "once");
    const first = materializePlatformSkills({
      workspaceDir,
      isolated: true,
      skillsRoot,
      entries: [{ name: "demo", sourceDir }],
    });
    const second = materializePlatformSkills({
      workspaceDir,
      isolated: true,
      skillsRoot,
      entries: [{ name: "demo", sourceDir }],
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.cached, true);
    const third = materializePlatformSkills({
      workspaceDir,
      isolated: true,
      skillsRoot,
      force: true,
      entries: [{ name: "demo", sourceDir }],
    });
    assert.equal(third.ok, true);
    assert.equal(third.cached, undefined);
    assert.match(
      fs.readFileSync(path.join(workspaceDir, ".agents", "skills", "demo", "SKILL.md"), "utf8"),
      /once/
    );
  } finally {
    fs.rmSync(skillsRoot, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("materialize skips non-isolated workspaces and invalid names", () => {
  resetMaterializeCache();
  const skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mat-skills-skip-"));
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "mat-ws-skip-"));
  try {
    const sourceDir = writeSkill(skillsRoot, "demo");
    const skipped = materializePlatformSkills({
      workspaceDir,
      isolated: false,
      skillsRoot,
      entries: [{ name: "demo", sourceDir }],
    });
    assert.equal(skipped.ok, false);
    assert.equal(skipped.skipped, "not-isolated");
    assert.equal(fs.existsSync(path.join(workspaceDir, ".agents")), false);

    const invalid = materializePlatformSkills({
      workspaceDir,
      isolated: true,
      skillsRoot,
      entries: [{ name: "../outside", sourceDir }],
    });
    assert.equal(invalid.ok, false);
    assert.match(invalid.errors.join("\n"), /invalid skill name/);
    assert.equal(fs.existsSync(path.join(workspaceDir, ".agents", "skills", "outside")), false);

    const escaped = materializePlatformSkills({
      workspaceDir,
      isolated: true,
      skillsRoot,
      entries: [{ name: "demo", sourceDir: path.join(os.tmpdir(), "not-skills-root") }],
    });
    assert.equal(escaped.ok, false);
    assert.match(escaped.errors.join("\n"), /source escaped skills root/);
    assert.equal(isInside(workspaceDir, path.join(workspaceDir, ".agents", "skills")), true);
  } finally {
    fs.rmSync(skillsRoot, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

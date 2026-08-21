const fs = require("node:fs");
const path = require("node:path");
const { ROOT } = require("../shared/runtime-paths");
const { parseSkillFrontmatter } = require("../shared/frontmatter");
const { isSafeSkillName, materializePlatformSkills } = require("../agents/skill-materialize");

const DEFAULT_SKILLS_DIR = path.join(ROOT, "skills");

/**
 * READONLY mode rule: injected into the agent prompt when worktree is not enabled.
 * This makes the worktree toggle an effective permission gate:
 *   - worktree on  → agent runs in isolated directory, can write files
 *   - worktree off → agent is told it's in read-only mode, must not write
 */
const READONLY_MODE_RULE = [
  "",
  "<!-- ═══════════════════════════════════════════════════════════ -->",
  "<!-- WORKTREE MODE: OFF (只读模式)                                  -->",
  "<!-- 当前未开启改代码模式，你处于只读模式。                          -->",
  "<!-- 禁止执行以下操作:                                              -->",
  "<!--   - write  / 创建新文件                                       -->",
  "<!--   - edit  / 修改现有文件                                      -->",
  "<!--   - bash  / 执行任何会产生文件副作用的命令                      -->",
  "<!-- 你可以: 查看代码、搜索、分析、回答问题、制定方案。              -->",
  "<!-- 如果需要修改代码，请告知用户: 请先开启改代码模式（勾选 worktree    -->",
  "<!-- 复选框），然后我会帮你实现。                                    -->",
  "<!-- ═══════════════════════════════════════════════════════════ -->",
  "",
].join("\n");

function skillRelativePath(name) {
  return path.posix.join("skills", name, "SKILL.md");
}

function readSkillDirectory(skillsDir, dirent) {
  if (!dirent.isDirectory() || dirent.name.startsWith(".")) return null;
  if (!isSafeSkillName(dirent.name)) return null;

  const sourceDir = path.join(skillsDir, dirent.name);
  const skillFile = path.join(sourceDir, "SKILL.md");
  if (!fs.existsSync(skillFile) || !fs.statSync(skillFile).isFile()) return null;

  const content = fs.readFileSync(skillFile, "utf8");
  const parsed = parseSkillFrontmatter(content);
  if (!parsed) return null;

  const metaName = parsed.meta.name || dirent.name;
  if (metaName !== dirent.name) return null;

  return {
    name: dirent.name,
    description: parsed.meta.description || "",
    triggers: parsed.meta.triggers || [],
    always: parsed.meta.always === true,
    body: parsed.body,
    sourceDir,
    path: skillRelativePath(dirent.name),
  };
}

/**
 * Load platform skills from skills/<name>/SKILL.md.
 * Flat leftover *.md files are ignored.
 * Returns { name, description, triggers, always, body, sourceDir, path }.
 */
function loadSkills(skillsDir) {
  if (!fs.existsSync(skillsDir)) return [];

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const skills = [];
  for (const dirent of entries) {
    const skill = readSkillDirectory(skillsDir, dirent);
    if (skill) skills.push(skill);
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/**
 * Match skills against a user prompt.
 * Returns skills whose triggers appear in the prompt, plus always-on skills.
 */
function matchSkills(prompt, skills) {
  const lowerPrompt = String(prompt || "").toLowerCase();
  const matched = [];

  for (const skill of skills) {
    if (skill.always) {
      matched.push(skill);
      continue;
    }

    for (const trigger of skill.triggers) {
      if (lowerPrompt.includes(String(trigger).toLowerCase())) {
        matched.push(skill);
        break;
      }
    }
  }

  return matched;
}

/**
 * Build an augmented prompt by prepending matched skill content as system instructions.
 * Fallback path only: native delivery copies SKILL.md into the isolated worktree
 * and MCP list/load_platform_skill serves on-demand bodies.
 */
function buildAugmentedPrompt(userPrompt, matchedSkills) {
  if (!matchedSkills || matchedSkills.length === 0) {
    return { augmentedPrompt: userPrompt, skillNames: [] };
  }

  const skillBlocks = matchedSkills.map((skill) => {
    return `<!-- APPLICATION SKILL: ${skill.name} -->\n${skill.body}`;
  });

  const header = [
    "<!-- ═══════════════════════════════════════════════════════════ -->",
    "<!-- 以下为应用层注入的元规则（System-level Meta-rules）           -->",
    "<!-- 这些不是 CLI 工具的原生 Skill，而是作为系统指令的一部分       -->",
    "<!-- 请严格遵循以下规则，它们针对 AI 常见弱点设计                  -->",
    "<!-- ═══════════════════════════════════════════════════════════ -->",
    "",
  ].join("\n");

  const augmentedPrompt = header + "\n" + skillBlocks.join("\n\n") + "\n\n---\n\n" + userPrompt;
  const skillNames = matchedSkills.map((s) => s.name);

  return { augmentedPrompt, skillNames };
}

function buildSkillCatalogPointer(skills) {
  const lines = (skills || []).map((skill) => {
    const description = String(skill.description || "").trim();
    return description ? `- ${skill.name}: ${description}` : `- ${skill.name}`;
  });
  return [
    "<!-- PLATFORM SKILL CATALOG -->",
    "平台协作 skill 已物化到工作区 `.agents/skills/<name>/SKILL.md`，供 CLI 原生发现。",
    "也可通过 MCP `list_platform_skills` / `load_platform_skill` 按需加载正文。",
    "本 prompt 不再注入 skill 全文。",
    "",
    ...lines,
    "<!-- /PLATFORM SKILL CATALOG -->",
    "",
  ].join("\n");
}

function isIsolatedWorkspace(workspaceDir, projectDir) {
  if (!workspaceDir || !projectDir) return false;
  return path.resolve(workspaceDir) !== path.resolve(projectDir);
}

/**
 * Create a skills service with optional directory override (useful for tests).
 */
function createSkillsService(options = {}) {
  const skillsDir = options.skillsDir || DEFAULT_SKILLS_DIR;
  const materialize = options.materializePlatformSkills || materializePlatformSkills;
  let cache = options.skills || null;

  function getSkills() {
    if (!cache) cache = loadSkills(skillsDir);
    return cache;
  }

  function resetCache() {
    cache = null;
  }

  function getSkillsRoot() {
    return skillsDir;
  }

  function publicSkills() {
    return getSkills().map((s) => ({
      name: s.name,
      description: s.description,
      triggers: s.triggers,
      always: s.always,
      path: s.path || skillRelativePath(s.name),
    }));
  }

  function listSkillIndex() {
    return getSkills().map((s) => ({
      name: s.name,
      description: s.description,
    }));
  }

  function getSkillByName(name) {
    if (!isSafeSkillName(name)) return null;
    return getSkills().find((skill) => skill.name === name) || null;
  }

  /**
   * @param {string} rawPrompt
   * @param {boolean} [useWorktree=true]
   * @param {{ skillNames?: string[], catalogPointer?: boolean }} [options]
   *   skillNames: inject an explicit allow-list of skill names (e.g. receiving-review).
   *   catalogPointer: prepend a short native/MCP index instead of relying on matchSkills.
   */
  function augmentPrompt(rawPrompt, useWorktree = true, options = {}) {
    const skills = getSkills();
    let matched;
    if (Array.isArray(options.skillNames)) {
      const want = new Set(options.skillNames);
      matched = skills.filter((s) => want.has(s.name));
    } else {
      matched = matchSkills(rawPrompt, skills);
    }
    const result = buildAugmentedPrompt(rawPrompt, matched);
    if (options.catalogPointer) {
      result.augmentedPrompt = `${buildSkillCatalogPointer(skills)}\n${result.augmentedPrompt}`;
    }
    if (!useWorktree) {
      result.augmentedPrompt = READONLY_MODE_RULE + "\n" + result.augmentedPrompt;
    }
    return result;
  }

  /**
   * Single delivery policy for a chat request.
   * Isolated worktree + successful copy → native/MCP, prompt catalog only.
   * Otherwise fallback to full augmentPrompt injection.
   */
  function prepareSkillDelivery({
    workspaceDir,
    projectDir,
    useWorktree = false,
    isolated = false,
    rawPrompt,
  } = {}) {
    const index = listSkillIndex();
    const isolatedWorkspace = isolated === true && isIsolatedWorkspace(workspaceDir, projectDir);
    let materializeResult = {
      ok: false,
      method: "skipped",
      targets: [],
      errors: [],
      skipped: isolatedWorkspace ? undefined : "not-isolated",
    };

    if (isolatedWorkspace) {
      const entries = getSkills().map((skill) => ({
        name: skill.name,
        sourceDir: skill.sourceDir,
      }));
      try {
        materializeResult = materialize({
          workspaceDir,
          isolated: true,
          entries,
          skillsRoot: getSkillsRoot(),
        });
      } catch (error) {
        materializeResult = {
          ok: false,
          method: "copy",
          targets: [],
          errors: [error.message],
        };
      }
    }

    const nativeDelivery = materializeResult.ok === true;
    const promptResult = nativeDelivery
      ? augmentPrompt(rawPrompt, useWorktree, { skillNames: [], catalogPointer: true })
      : augmentPrompt(rawPrompt, useWorktree);

    return {
      nativeDelivery,
      materialize: materializeResult,
      augmentedPrompt: promptResult.augmentedPrompt,
      skillNames: nativeDelivery ? index.map((skill) => skill.name) : promptResult.skillNames,
    };
  }

  return {
    skillsDir,
    getSkills,
    getSkillsRoot,
    getSkillByName,
    resetCache,
    publicSkills,
    listSkillIndex,
    matchSkills: (prompt) => matchSkills(prompt, getSkills()),
    augmentPrompt,
    prepareSkillDelivery,
    loadSkills: () => loadSkills(skillsDir),
  };
}

// Process-wide default service (server entry uses this).
const defaultSkills = createSkillsService();

module.exports = {
  DEFAULT_SKILLS_DIR,
  READONLY_MODE_RULE,
  parseSkillFrontmatter,
  loadSkills,
  matchSkills,
  buildAugmentedPrompt,
  buildSkillCatalogPointer,
  createSkillsService,
  getSkills: defaultSkills.getSkills,
  getSkillsRoot: defaultSkills.getSkillsRoot,
  getSkillByName: defaultSkills.getSkillByName,
  publicSkills: defaultSkills.publicSkills,
  listSkillIndex: defaultSkills.listSkillIndex,
  augmentPrompt: defaultSkills.augmentPrompt,
  prepareSkillDelivery: defaultSkills.prepareSkillDelivery,
  resetSkillsCache: defaultSkills.resetCache,
};

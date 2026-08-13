const fs = require("node:fs");
const path = require("node:path");
const { ROOT } = require("../shared/runtime-paths");
const { parseSkillFrontmatter } = require("../shared/frontmatter");

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

/**
 * Load all skill files from the skills directory.
 * Returns an array of { name, description, triggers, always, body }.
 */
function loadSkills(skillsDir) {
  if (!fs.existsSync(skillsDir)) return [];

  const files = fs.readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
  const skills = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(skillsDir, file), "utf8");
    const parsed = parseSkillFrontmatter(content);
    if (!parsed) continue;

    skills.push({
      name: parsed.meta.name || file.replace(".md", ""),
      description: parsed.meta.description || "",
      triggers: parsed.meta.triggers || [],
      always: parsed.meta.always === true,
      body: parsed.body,
    });
  }

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
 * The skill content is wrapped in a clearly delineated block so the CLI tool
 * sees it as part of the user message, NOT as a CLI-native skill.
 *
 * This is the ISOLATION key: skills are plain text injected into the prompt,
 * never written to codex/opencode skill directories.
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

/**
 * Create a skills service with optional directory override (useful for tests).
 */
function createSkillsService(options = {}) {
  const skillsDir = options.skillsDir || DEFAULT_SKILLS_DIR;
  let cache = options.skills || null;

  function getSkills() {
    if (!cache) cache = loadSkills(skillsDir);
    return cache;
  }

  function resetCache() {
    cache = null;
  }

  function publicSkills() {
    return getSkills().map((s) => ({
      name: s.name,
      description: s.description,
      triggers: s.triggers,
      always: s.always,
    }));
  }

  /**
   * @param {string} rawPrompt
   * @param {boolean} [useWorktree=true]
   * @param {{ skillNames?: string[] }} [options]
   *   skillNames: inject an explicit allow-list of skill names (e.g. receiving-review).
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
    if (!useWorktree) {
      result.augmentedPrompt = READONLY_MODE_RULE + "\n" + result.augmentedPrompt;
    }
    return result;
  }

  return {
    skillsDir,
    getSkills,
    resetCache,
    publicSkills,
    matchSkills: (prompt) => matchSkills(prompt, getSkills()),
    augmentPrompt,
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
  createSkillsService,
  getSkills: defaultSkills.getSkills,
  publicSkills: defaultSkills.publicSkills,
  augmentPrompt: defaultSkills.augmentPrompt,
  resetSkillsCache: defaultSkills.resetCache,
};

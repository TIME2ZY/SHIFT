/**
 * Copy platform skills into an isolated workspace for native CLI discovery.
 * Authority stays in the repo skills/ tree; this writes a derived replica only.
 * Callers must pass already-resolved entries from src/server/skills.js.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SAFE_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DISCOVERY_REL = path.join(".agents", "skills");
const OWNERSHIP_MARKER = ".shift-platform-skill";

const materializeCache = new Map();

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || Boolean(rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function isSafeSkillName(name) {
  return typeof name === "string" && SAFE_SKILL_NAME.test(name);
}

function copySkillDir(sourceDir, destDir) {
  fs.cpSync(sourceDir, destDir, { recursive: true, force: true });
}

function excludeDiscoveryPath(workspaceDir) {
  try {
    const result = spawnSync("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd: workspaceDir,
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0) return;
    const raw = String(result.stdout || "").trim();
    if (!raw) return;
    const excludePath = path.isAbsolute(raw) ? raw : path.join(workspaceDir, raw);
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
    const entry = ".agents/skills/";
    if (existing.split(/\r?\n/).includes(entry)) return;
    fs.appendFileSync(
      excludePath,
      `${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}${entry}\n`,
      "utf8"
    );
  } catch {
    // Best-effort: native discovery still works if exclude cannot be updated.
  }
}

function cacheKey(workspaceDir) {
  return path.resolve(workspaceDir);
}

function entriesSignature(entries) {
  return (entries || [])
    .map((entry) => `${entry.name}\0${path.resolve(entry.sourceDir)}`)
    .sort()
    .join("\n");
}

/**
 * Materialize platform skills into a workspace for native CLI discovery.
 * @param {{
 *   workspaceDir: string,
 *   isolated?: boolean,
 *   entries?: { name: string, sourceDir: string }[],
 *   skillsRoot?: string,
 *   force?: boolean,
 * }} opts
 * @returns {{ ok: boolean, method: string, targets: string[], errors: string[], skipped?: string }}
 */
function materializePlatformSkills(opts = {}) {
  const workspaceDir = opts.workspaceDir;
  const entries = Array.isArray(opts.entries) ? opts.entries : [];
  const isolated = opts.isolated === true;
  const force = opts.force === true;

  if (!workspaceDir || typeof workspaceDir !== "string") {
    return {
      ok: false,
      method: "skipped",
      targets: [],
      errors: ["workspaceDir is required"],
      skipped: "invalid-workspace",
    };
  }
  if (!isolated) {
    return {
      ok: false,
      method: "skipped",
      targets: [],
      errors: [],
      skipped: "not-isolated",
    };
  }

  const root = path.resolve(workspaceDir);
  if (!force) {
    const cached = materializeCache.get(cacheKey(root));
    if (cached && cached.signature === entriesSignature(entries) && cached.result.ok) {
      return { ...cached.result, cached: true };
    }
  }

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return {
      ok: false,
      method: "skipped",
      targets: [],
      errors: [`workspace is not a directory: ${root}`],
      skipped: "missing-workspace",
    };
  }

  const destRoot = path.join(root, DISCOVERY_REL);
  if (!isInside(root, destRoot)) {
    return {
      ok: false,
      method: "copy",
      targets: [],
      errors: ["skill discovery path escaped the workspace"],
    };
  }

  const skillsRoot = opts.skillsRoot ? path.resolve(opts.skillsRoot) : null;
  const errors = [];
  const targets = [];
  const removed = [];

  try {
    fs.mkdirSync(destRoot, { recursive: true });
    excludeDiscoveryPath(root);
  } catch (error) {
    return {
      ok: false,
      method: "copy",
      targets: [],
      errors: [`cannot create ${destRoot}: ${error.message}`],
    };
  }

  const wantedNames = new Set(entries.map((entry) => entry?.name).filter(isSafeSkillName));
  for (const dirent of fs.readdirSync(destRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory() || wantedNames.has(dirent.name)) continue;
    const staleDir = path.resolve(destRoot, dirent.name);
    const marker = path.join(staleDir, OWNERSHIP_MARKER);
    if (!isInside(destRoot, staleDir) || !fs.existsSync(marker)) continue;
    fs.rmSync(staleDir, { recursive: true, force: true });
    removed.push(staleDir);
  }

  for (const entry of entries) {
    const name = entry && entry.name;
    if (!isSafeSkillName(name)) {
      errors.push(`invalid skill name: ${String(name || "")}`);
      continue;
    }
    const sourceDir = path.resolve(String(entry.sourceDir || ""));
    const destDir = path.join(destRoot, name);
    if (!isInside(destRoot, destDir) || !isInside(root, destDir)) {
      errors.push(`${name}: destination escaped the workspace`);
      continue;
    }
    if (skillsRoot && !isInside(skillsRoot, sourceDir)) {
      errors.push(`${name}: source escaped skills root`);
      continue;
    }
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      errors.push(`${name}: source directory is missing`);
      continue;
    }
    try {
      if (fs.existsSync(destDir)) {
        const marker = path.join(destDir, OWNERSHIP_MARKER);
        if (!fs.existsSync(marker)) {
          errors.push(`${name}: destination exists and is not owned by SHIFT`);
          continue;
        }
        fs.rmSync(destDir, { recursive: true, force: true });
      }
      copySkillDir(sourceDir, destDir);
      const skillFile = path.join(destDir, "SKILL.md");
      if (!fs.existsSync(skillFile)) {
        errors.push(`${name}: copied directory is missing SKILL.md`);
        continue;
      }
      fs.writeFileSync(path.join(destDir, OWNERSHIP_MARKER), "owned-by=SHIFT\n", "utf8");
      targets.push(destDir);
    } catch (error) {
      errors.push(`${name}: ${error.message}`);
    }
  }

  const result = {
    ok: errors.length === 0 && targets.length === entries.length,
    method: "copy",
    targets,
    removed,
    errors,
  };
  materializeCache.set(cacheKey(root), { signature: entriesSignature(entries), result });
  return result;
}

function resetMaterializeCache() {
  materializeCache.clear();
}

module.exports = {
  SAFE_SKILL_NAME,
  DISCOVERY_REL,
  OWNERSHIP_MARKER,
  isSafeSkillName,
  isInside,
  materializePlatformSkills,
  resetMaterializeCache,
};

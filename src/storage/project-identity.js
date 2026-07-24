const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/**
 * Resolve a stable project identity from a workspace directory.
 * @see docs/memory-data-contract.md §12
 */
function resolveProjectIdentity(projectDir, options = {}) {
  const raw = typeof projectDir === "string" ? projectDir.trim() : "";
  if (!raw) {
    return {
      kind: "none",
      projectKey: null,
      canonicalPath: null,
      resolution: "none",
    };
  }

  let resolved = path.resolve(raw);
  let realpathFailed = false;
  try {
    resolved = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch {
    realpathFailed = true;
  }

  const canonicalPath = normalizeCanonicalPath(resolved);
  const git = options.skipGit ? null : detectGitWorktreeRoot(resolved, options);

  if (git?.worktreeRoot) {
    const wtCanonical = normalizeCanonicalPath(git.worktreeRoot);
    return {
      kind: "git-worktree",
      projectKey: buildProjectKey("wt", wtCanonical),
      canonicalPath: wtCanonical,
      worktreeRoot: wtCanonical,
      gitCommonDir: git.commonDir || null,
      resolution: "git-worktree-root",
      realpathFailed,
    };
  }

  return {
    kind: "directory",
    projectKey: buildProjectKey("dir", canonicalPath),
    canonicalPath,
    resolution: "normalized-path",
    realpathFailed,
  };
}

function buildProjectKey(prefix, canonicalPath) {
  const hash = crypto.createHash("sha256").update(canonicalPath, "utf8").digest("hex").slice(0, 32);
  return `${prefix}:${hash}`;
}

function normalizeCanonicalPath(value) {
  let normalized = String(value || "").replace(/\\/g, "/");
  if (process.platform === "win32" && /^[A-Za-z]:/.test(normalized)) {
    normalized = normalized[0].toLowerCase() + normalized.slice(1);
  }
  // Trim trailing slash except for root paths (C:/ or /).
  if (normalized.length > 1 && normalized.endsWith("/")) {
    if (!(normalized.length === 3 && /^[a-z]:\/$/i.test(normalized))) {
      normalized = normalized.replace(/\/+$/, "");
    }
  }
  return normalized;
}

function detectGitWorktreeRoot(cwd, options = {}) {
  const exec = options.execFileSync || execFileSync;
  try {
    const worktreeRoot = String(
      exec("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      })
    ).trim();
    if (!worktreeRoot) return null;
    let commonDir = null;
    try {
      commonDir = String(
        exec("git", ["rev-parse", "--git-common-dir"], {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        })
      ).trim();
      if (commonDir && !path.isAbsolute(commonDir)) {
        commonDir = path.resolve(worktreeRoot, commonDir);
      }
      commonDir = normalizeCanonicalPath(commonDir);
    } catch {
      commonDir = null;
    }
    return {
      worktreeRoot: normalizeCanonicalPath(path.resolve(worktreeRoot)),
      commonDir,
    };
  } catch {
    return null;
  }
}

module.exports = {
  resolveProjectIdentity,
  buildProjectKey,
  normalizeCanonicalPath,
  detectGitWorktreeRoot,
};

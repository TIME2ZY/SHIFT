const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { assertValidOpaqueId, resolveInside } = require("../server/id-policy");
const { ENV, LOCAL_STATE_DIR } = require("../shared/brand");
const { ROOT, createRuntimePaths } = require("../shared/runtime-paths");

function sanitizeId(id) {
  return assertValidOpaqueId(id, "sessionId");
}

function runGit(args, cwd, opts = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: opts.maxBuffer || 10 * 1024 * 1024,
  });
  const allowed = new Set([0, ...(opts.allowStatus || [])]);
  if (!allowed.has(result.status)) {
    const message = (result.stderr || result.stdout || "").trim();
    throw new Error(message || `git ${args.join(" ")} failed`);
  }
  return (result.stdout || "").trim();
}

function normalizeFsPath(target) {
  const resolved = path.resolve(target);
  try {
    // Expand Windows 8.3 short paths (e.g. ZHANGC~1) so path compares stay stable.
    return fs.realpathSync.native(resolved);
  } catch {
    try {
      return fs.realpathSync(resolved);
    } catch {
      return resolved;
    }
  }
}

function ensureGitRoot(baseDir) {
  const resolved = normalizeFsPath(baseDir);
  if (!fs.existsSync(resolved)) throw new Error(`Directory not found: ${resolved}`);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`Not a directory: ${resolved}`);
  try {
    return normalizeFsPath(runGit(["rev-parse", "--show-toplevel"], resolved));
  } catch (error) {
    throw new Error(`${resolved} is not a git repository: ${error.message}`);
  }
}

function readState(filePath) {
  if (!fs.existsSync(filePath)) return { worktrees: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return { worktrees: parsed.worktrees || {} };
  } catch {
    return { worktrees: {} };
  }
}

function writeState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tempFile, filePath);
}

function isInside(parent, child) {
  const rel = path.relative(normalizeFsPath(parent), normalizeFsPath(child));
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function registeredWorktreePaths(gitRoot) {
  return new Set(
    runGit(["worktree", "list", "--porcelain"], gitRoot)
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => normalizeFsPath(line.slice("worktree ".length)))
  );
}

function writeWorktreeEnv(meta) {
  const envPath = path.join(meta.worktreeDir, ".env.local");
  const lines = [
    `${ENV.WORKTREE}=1`,
    `${ENV.SESSION_ID}=${meta.sessionId}`,
    `${ENV.BASE_DIR}=${meta.baseDir}`,
    `${ENV.WORKTREE_DIR}=${meta.worktreeDir}`,
    `${ENV.BRANCH}=${meta.branch}`,
    "",
  ];
  fs.writeFileSync(envPath, lines.join("\n"), "utf8");
}

function excludeGeneratedFiles(worktreeDir) {
  const excludePath = runGit(["rev-parse", "--git-path", "info/exclude"], worktreeDir);
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
  const entries = [".env.local", `${LOCAL_STATE_DIR}/`, ".agents/skills/"];
  const missing = entries.filter((entry) => !existing.split(/\r?\n/).includes(entry));
  if (missing.length > 0) {
    fs.appendFileSync(
      excludePath,
      `${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}${missing.join("\n")}\n`,
      "utf8"
    );
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {}
    }
  } catch {}
}

function createWorktreeManager(opts = {}) {
  const rootDir = path.resolve(opts.rootDir || ROOT);
  const stateFile = path.resolve(
    opts.stateFile || createRuntimePaths({ env: opts.env || process.env }).worktreeStateFile
  );

  function load() {
    return readState(stateFile);
  }

  function save(state) {
    writeState(stateFile, state);
  }

  function ensureWorktree({ baseDir, sessionId }) {
    const safeSessionId = sanitizeId(sessionId);
    const gitRoot = ensureGitRoot(baseDir || rootDir);
    const state = load();
    const existing = state.worktrees[safeSessionId];
    if (existing && fs.existsSync(existing.worktreeDir)) return existing;

    const worktreesRoot = path.resolve(opts.worktreesRoot || `${gitRoot}.worktrees`);
    const worktreeDir = resolveInside(worktreesRoot, safeSessionId);
    const branch = `codex/session-${safeSessionId}`;

    fs.mkdirSync(worktreesRoot, { recursive: true });
    if (!fs.existsSync(worktreeDir)) {
      runGit(["worktree", "add", "-B", branch, worktreeDir, "HEAD"], gitRoot);
    }

    const meta = {
      sessionId: safeSessionId,
      baseDir: gitRoot,
      worktreeDir,
      branch,
      status: "active",
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeWorktreeEnv(meta);
    excludeGeneratedFiles(worktreeDir);
    state.worktrees[safeSessionId] = meta;
    save(state);
    return meta;
  }

  function getWorktree(sessionId) {
    const safeSessionId = sanitizeId(sessionId);
    const meta = load().worktrees[safeSessionId];
    if (!meta || !fs.existsSync(meta.worktreeDir)) {
      throw new Error(`No managed worktree for session ${safeSessionId}.`);
    }
    return meta;
  }

  function getStatus(sessionId) {
    const meta = getWorktree(sessionId);
    const porcelain = runGit(["status", "--porcelain"], meta.worktreeDir)
      .split(/\r?\n/)
      .filter(Boolean);
    return {
      ...meta,
      headSha: runGit(["rev-parse", "HEAD"], meta.worktreeDir),
      clean: porcelain.length === 0,
      porcelain,
    };
  }

  function getDiff(sessionId) {
    const meta = getWorktree(sessionId);
    const tracked = runGit(["diff", "--no-ext-diff", "--"], meta.worktreeDir);
    const untracked = runGit(["ls-files", "--others", "--exclude-standard"], meta.worktreeDir)
      .split(/\r?\n/)
      .filter(Boolean);
    const parts = [];
    if (tracked) parts.push(tracked);
    for (const file of untracked) {
      parts.push(
        runGit(["diff", "--no-index", "--", osNullPath(), file], meta.worktreeDir, {
          maxBuffer: 20 * 1024 * 1024,
          allowStatus: [1],
        })
      );
    }
    return parts.join("\n");
  }

  function discardWorktree(sessionId) {
    const safeSessionId = sanitizeId(sessionId);
    // Stop preview server before removing worktree
    try {
      stopPreview(safeSessionId);
    } catch {}
    const state = load();
    const meta = state.worktrees[safeSessionId];
    if (!meta) throw new Error(`No managed worktree for session ${safeSessionId}.`);

    // Treat the persisted state as untrusted input. Re-validate the repository
    // and require Git to recognize the exact target before any recursive fallback.
    const trustedBaseDir = ensureGitRoot(meta.baseDir);
    if (trustedBaseDir !== normalizeFsPath(meta.baseDir)) {
      throw new Error(`Refusing worktree with invalid base repository: ${meta.baseDir}`);
    }
    const worktreesRoot = normalizeFsPath(opts.worktreesRoot || `${trustedBaseDir}.worktrees`);
    const resolvedDir = normalizeFsPath(meta.worktreeDir);
    if (!isInside(worktreesRoot, resolvedDir)) {
      throw new Error(`Refusing to remove unmanaged path: ${resolvedDir}`);
    }
    if (!registeredWorktreePaths(trustedBaseDir).has(resolvedDir)) {
      throw new Error(`Refusing to remove unregistered worktree: ${resolvedDir}`);
    }

    if (fs.existsSync(resolvedDir)) {
      try {
        runGit(["worktree", "remove", "--force", resolvedDir], trustedBaseDir);
      } catch {
        fs.rmSync(resolvedDir, { recursive: true, force: true });
        try {
          runGit(["worktree", "prune"], trustedBaseDir);
        } catch {}
      }
    }

    delete state.worktrees[safeSessionId];
    save(state);
    return { ok: true, sessionId: safeSessionId, worktreeDir: resolvedDir };
  }

  const previewProcesses = new Map();

  async function startPreview(sessionId) {
    const safeSessionId = sanitizeId(sessionId);
    const existing = load().worktrees[safeSessionId];
    if (!existing) throw new Error(`No managed worktree for session ${safeSessionId}.`);

    // Already running
    if (existing.previewPid && previewProcesses.has(safeSessionId)) {
      return existing;
    }

    const port = await findFreePort();
    const env = {
      ...process.env,
      PORT: String(port),
      NODE_PATH: path.join(rootDir, "node_modules"),
      [ENV.RUNTIME_ROOT]: rootDir,
      [ENV.PREVIEW]: "1",
    };
    const child = spawn("node", ["src/server/index.js"], {
      cwd: existing.worktreeDir,
      env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();

    child.on("exit", () => {
      previewProcesses.delete(safeSessionId);
      try {
        const st = load();
        if (st.worktrees[safeSessionId]) {
          st.worktrees[safeSessionId].previewPid = null;
          st.worktrees[safeSessionId].previewPort = null;
          st.worktrees[safeSessionId].previewUrl = null;
          save(st);
        }
      } catch {}
    });

    previewProcesses.set(safeSessionId, child);

    const state = load();
    state.worktrees[safeSessionId] = {
      ...existing,
      previewPort: port,
      previewPid: child.pid,
      previewUrl: `http://127.0.0.1:${port}`,
      updatedAt: new Date().toISOString(),
    };
    save(state);
    return state.worktrees[safeSessionId];
  }

  function stopPreview(sessionId) {
    const safeSessionId = sanitizeId(sessionId);
    const meta = load().worktrees[safeSessionId];
    if (!meta || !meta.previewPid) return;
    killProcessTree(meta.previewPid);
    previewProcesses.delete(safeSessionId);
    const state = load();
    if (state.worktrees[safeSessionId]) {
      state.worktrees[safeSessionId].previewPid = null;
      state.worktrees[safeSessionId].previewPort = null;
      state.worktrees[safeSessionId].previewUrl = null;
      save(state);
    }
  }

  function stopAllPreviews() {
    for (const sid of Array.from(previewProcesses.keys())) {
      try {
        stopPreview(sid);
      } catch {}
    }
  }

  return {
    ensureWorktree,
    getWorktree,
    getStatus,
    getDiff,
    discardWorktree,
    startPreview,
    stopPreview,
    stopAllPreviews,
  };
}

function osNullPath() {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

module.exports = {
  createWorktreeManager,
  sanitizeId,
  ensureGitRoot,
};

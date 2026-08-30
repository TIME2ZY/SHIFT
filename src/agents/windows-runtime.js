const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function findPwsh(env = process.env, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") return "";
  const existsSync = options.existsSync || fs.existsSync;
  const explicit = String(env.SHIFT_PWSH_PATH || env.PWSH_PATH || "").trim();
  if (explicit) return explicit;

  const delimiter = options.delimiter || ";";
  const pathValue = String(env.PATH || env.Path || "");
  for (const entry of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = path.join(entry, "pwsh.exe");
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

function windowsUtf8Environment(env = process.env, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") return {};
  const pwsh = findPwsh(env, options);
  return {
    LANG: env.LANG || "C.UTF-8",
    LC_ALL: env.LC_ALL || "C.UTF-8",
    PYTHONUTF8: env.PYTHONUTF8 || "1",
    PYTHONIOENCODING: env.PYTHONIOENCODING || "utf-8",
    ...(pwsh ? { SHELL: pwsh, SHIFT_PWSH_PATH: pwsh } : {}),
  };
}

function childPid(child) {
  const pid = Number(child && child.pid);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

/**
 * Kill a spawned provider (and its Windows process tree). SIGTERM/SIGKILL on
 * win32 only hit the wrapper PID; `taskkill /T /F` is required to reap
 * hung `codex.cmd` / pwsh grandchildren.
 */
function killProcessTree(child, signal = "SIGTERM", options = {}) {
  const platform = options.platform || process.platform;
  const spawnSyncFn = options.spawnSync || spawnSync;
  const pid = childPid(child);
  if (platform === "win32" && pid) {
    try {
      spawnSyncFn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      return;
    } catch {
      // Fall through to child.kill when taskkill is unavailable.
    }
  }
  if (child && typeof child.kill === "function") {
    child.kill(signal);
  }
}

module.exports = {
  findPwsh,
  windowsUtf8Environment,
  killProcessTree,
};

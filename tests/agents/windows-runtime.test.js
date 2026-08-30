const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  findPwsh,
  windowsUtf8Environment,
  killProcessTree,
} = require("../../src/agents/windows-runtime");

test("findPwsh prefers an explicit configured path", () => {
  assert.equal(
    findPwsh(
      { SHIFT_PWSH_PATH: "C:\\Tools\\pwsh.exe" },
      { platform: "win32", existsSync: () => false }
    ),
    "C:\\Tools\\pwsh.exe"
  );
});

test("findPwsh locates pwsh.exe on the Windows PATH", () => {
  const expected = path.join("C:\\Tools", "pwsh.exe");
  assert.equal(
    findPwsh(
      { PATH: "C:\\Other;C:\\Tools" },
      { platform: "win32", existsSync: (candidate) => candidate === expected }
    ),
    expected
  );
});

test("Windows provider environment prefers pwsh and UTF-8 defaults", () => {
  const patch = windowsUtf8Environment(
    { PWSH_PATH: "C:\\Tools\\pwsh.exe", LANG: "zh_CN.UTF-8" },
    { platform: "win32" }
  );
  assert.deepEqual(patch, {
    LANG: "zh_CN.UTF-8",
    LC_ALL: "C.UTF-8",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    SHELL: "C:\\Tools\\pwsh.exe",
    SHIFT_PWSH_PATH: "C:\\Tools\\pwsh.exe",
  });
});

test("non-Windows provider environment remains unchanged", () => {
  assert.deepEqual(windowsUtf8Environment({}, { platform: "linux" }), {});
});

test("Windows kill uses taskkill for a process tree", () => {
  const calls = [];
  killProcessTree(
    {
      pid: 4321,
      kill() {
        throw new Error("should not fall back");
      },
    },
    "SIGTERM",
    {
      platform: "win32",
      spawnSync: (command, args, options) => {
        calls.push({ command, args, options });
      },
    }
  );
  assert.deepEqual(calls, [
    {
      command: "taskkill",
      args: ["/pid", "4321", "/T", "/F"],
      options: { windowsHide: true },
    },
  ]);
});

test("non-Windows kill uses the child signal", () => {
  const signals = [];
  killProcessTree({ pid: 99, kill: (signal) => signals.push(signal) }, "SIGTERM", {
    platform: "linux",
    spawnSync() {
      throw new Error("taskkill must not run off Windows");
    },
  });
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("Windows kill without a pid falls back to child.kill", () => {
  const signals = [];
  killProcessTree({ kill: (signal) => signals.push(signal) }, "SIGKILL", {
    platform: "win32",
    spawnSync() {
      throw new Error("taskkill needs a pid");
    },
  });
  assert.deepEqual(signals, ["SIGKILL"]);
});

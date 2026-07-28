const test = require("node:test");
const assert = require("node:assert/strict");

const path = require("node:path");
const {
  buildCodexEnvironment,
  resolveCodexLauncher,
} = require("../../src/agents/providers/codex");

test("Codex child uses the configured isolated home", () => {
  assert.deepEqual(
    buildCodexEnvironment({}, { INVOKE_CODEX_HOME: " C:\\Users\\me\\.codex-cli " }),
    { CODEX_HOME: "C:\\Users\\me\\.codex-cli" }
  );
});

test("Codex child leaves CODEX_HOME unchanged without an override", () => {
  assert.deepEqual(buildCodexEnvironment({}, {}), {});
});

test("Codex launcher uses the command directly outside Windows", () => {
  assert.deepEqual(resolveCodexLauncher({}, { platform: "linux" }), {
    command: "codex",
    argsPrefix: [],
  });
});

test("Codex launcher runs the Windows npm package entry with Node", () => {
  const npmDir = "C:\\Users\\test\\AppData\\Roaming\\npm";
  const cmdShim = path.win32.join(npmDir, "codex.cmd");
  const packageEntry = path.win32.join(
    npmDir,
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js"
  );
  const existing = new Set([cmdShim.toLowerCase(), packageEntry.toLowerCase()]);
  const launcher = resolveCodexLauncher(
    { Path: `C:\\Windows\\System32;${npmDir}` },
    {
      platform: "win32",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      existsSync: (candidate) => existing.has(String(candidate).toLowerCase()),
    }
  );

  assert.deepEqual(launcher, {
    command: "C:\\Program Files\\nodejs\\node.exe",
    argsPrefix: [packageEntry],
  });
});

test("Codex launcher prefers a native Windows executable", () => {
  const nativeCommand = "C:\\Tools\\codex.exe";
  const launcher = resolveCodexLauncher(
    { PATH: "C:\\Tools" },
    {
      platform: "win32",
      existsSync: (candidate) => String(candidate).toLowerCase() === nativeCommand.toLowerCase(),
    }
  );

  assert.deepEqual(launcher, { command: nativeCommand, argsPrefix: [] });
});

test("Codex launcher supports an explicit package entry override", () => {
  const packageEntry = "D:\\portable\\codex\\bin\\codex.js";
  assert.deepEqual(
    resolveCodexLauncher(
      { INVOKE_CODEX_PATH: packageEntry },
      { platform: "win32", nodePath: "C:\\node\\node.exe" }
    ),
    {
      command: "C:\\node\\node.exe",
      argsPrefix: [packageEntry],
    }
  );
});

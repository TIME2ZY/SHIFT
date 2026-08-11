const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TESTS_DIR = path.join(ROOT, "tests");
const RUNTIME_PATH_CONTRACT_TEST = path.join(TESTS_DIR, "server", "runtime-paths.test.js");

function collectTests(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) return collectTests(target);
      return entry.isFile() && entry.name.endsWith(".test.js") ? [target] : [];
    })
    .sort();
}

function assertNoRealRuntimeDependencies(testFiles) {
  const directRuntimePath =
    /data[\\/]+runtime[\\/]+(?:sessions\.json|invocations\.json|memory\.sqlite|shift\.sqlite|transcripts|session-maps)/i;
  const runtimeConstant =
    /\b(?:DEFAULT_SESSIONS_FILE|DEFAULT_INVOCATIONS_FILE|DEFAULT_SESSION_MAP_ROOT|DEFAULT_TRANSCRIPT_DIR|DEFAULT_MEMORY_DB_FILE|LEGACY_MEMORY_DB_FILE)\b/;
  const defaultServer = /\bcreateServer\s*\(\s*\)/;
  const violations = [];

  for (const file of testFiles) {
    if (file === RUNTIME_PATH_CONTRACT_TEST) continue;
    const source = fs.readFileSync(file, "utf8");
    if (directRuntimePath.test(source)) violations.push(`${file}: direct data/runtime path`);
    if (runtimeConstant.test(source)) violations.push(`${file}: default runtime path constant`);
    if (defaultServer.test(source))
      violations.push(`${file}: createServer() without isolated paths`);
  }
  if (violations.length > 0) {
    throw new Error(
      `Tests must use temp directories or tests/fixtures, never real runtime data:\n${violations.join("\n")}`
    );
  }
  console.log(`test-storage-boundary: ok (${testFiles.length} isolated test files)`);
}

const testFiles = collectTests(TESTS_DIR);
assertNoRealRuntimeDependencies(testFiles);

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shift-tests-"));

try {
  const result = spawnSync(process.execPath, ["--test", ...testFiles], {
    cwd: ROOT,
    env: {
      ...process.env,
      SHIFT_HOME: runtimeRoot,
    },
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
}

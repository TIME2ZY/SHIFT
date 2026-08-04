const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("ACP SDK resolves from the Shift runtime when workspace has no node_modules", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "shift-acp-workspace-"));
  const invokeAcpPath = path.resolve(__dirname, "..", "..", "src", "agents", "invoke-acp.js");
  const script = [
    "const { loadAcpSdk } = require(process.argv[1]);",
    "loadAcpSdk().then(() => process.stdout.write('ok')).catch((error) => {",
    "  console.error(error);",
    "  process.exitCode = 1;",
    "});",
  ].join("\n");

  assert.equal(fs.existsSync(path.join(workspaceDir, "node_modules")), false);
  const result = spawnSync(process.execPath, ["-e", script, invokeAcpPath], {
    cwd: workspaceDir,
    env: { ...process.env, NODE_PATH: "" },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "ok");
});

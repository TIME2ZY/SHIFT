const crypto = require("node:crypto");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const viteBin = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
const sharedEnv = {
  ...process.env,
  SHIFT_UI_TOKEN: process.env.SHIFT_UI_TOKEN || crypto.randomBytes(32).toString("base64url"),
};
const children = new Set();
let shuttingDown = false;

function start(command, args) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: sharedEnv,
    stdio: "inherit",
  });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (shuttingDown) return;
    shuttingDown = true;
    for (const sibling of children) sibling.kill();
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  return child;
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.once("exit", shutdown);

start(process.execPath, [path.join(ROOT, "src", "server", "index.js")]);
start(process.execPath, [viteBin, "--config", path.join(ROOT, "web", "vite.config.ts")]);

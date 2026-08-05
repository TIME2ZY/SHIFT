#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const VERIFY_SCRIPTS = Object.freeze([
  "check",
  "lint",
  "test",
  "typecheck:web",
  "test:web",
  "build:web",
]);

function npmInvocation(scriptName) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return {
      command: process.execPath,
      args: [npmExecPath, "run", scriptName],
      shell: false,
    };
  }

  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", scriptName],
    shell: process.platform === "win32",
  };
}

function main() {
  for (const scriptName of VERIFY_SCRIPTS) {
    console.log(`\nverify-pr: npm run ${scriptName}`);
    const invocation = npmInvocation(scriptName);
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: ROOT,
      env: process.env,
      stdio: "inherit",
      shell: invocation.shell,
    });

    if (result.error) {
      console.error(`verify-pr: could not run ${scriptName}: ${result.error.message}`);
      process.exit(1);
    }
    if (result.status !== 0) {
      console.error(`verify-pr: ${scriptName} failed with exit code ${result.status ?? "unknown"}.`);
      process.exit(result.status ?? 1);
    }
  }

  console.log("\nverify-pr: all checks passed.");
}

main();

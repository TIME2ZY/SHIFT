"use strict";

/**
 * Sandbox target preparation: materialize a real upstream repository at the
 * instance base commit, apply the F2P test patch as a committed baseline,
 * and run the project test runner with machine-readable output.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function git(targetDir, args, options = {}) {
  const result = spawnSync("git", ["-C", targetDir, ...args], {
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`git ${args.join(" ")} failed in ${targetDir}: ${detail}`);
  }
  return result.stdout;
}

function createSandbox({
  instance,
  source,
  targetDir,
  nodeModules,
  logger = () => {},
  applyTestPatch = true,
  install = true,
}) {
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  logger(`cloning ${source} -> ${targetDir}`);
  const clone = spawnSync("git", ["clone", "--quiet", source, targetDir], { encoding: "utf8" });
  if (clone.status !== 0) {
    throw new Error(`git clone failed: ${(clone.stderr || "").trim()}`);
  }
  // Keep the worktree byte-identical to the upstream tree so the committed
  // test patch applies cleanly regardless of host autocrlf settings.
  git(targetDir, ["config", "core.autocrlf", "false"]);
  git(targetDir, ["checkout", "--quiet", instance.baseCommit]);
  git(targetDir, ["config", "user.name", "shift-live"]);
  git(targetDir, ["config", "user.email", "shift-live@local"]);

  if (applyTestPatch) {
    logger(`applying F2P test patch: ${path.basename(instance.testPatchPath)}`);
    const apply = spawnSync(
      "git",
      ["-C", targetDir, "apply", "--whitespace=nowarn", path.resolve(instance.testPatchPath)],
      { encoding: "utf8" }
    );
    if (apply.status !== 0) {
      throw new Error(`test patch does not apply at base commit: ${(apply.stderr || "").trim()}`);
    }
    git(targetDir, ["add", "-A"]);
    git(targetDir, [
      "commit",
      "--no-verify",
      "--quiet",
      "-m",
      `test: add F2P regression tests (${instance.id})`,
    ]);
  }

  if (install) {
    if (nodeModules) {
      const linkPath = path.join(targetDir, "node_modules");
      const absoluteSource = path.resolve(nodeModules);
      if (!fs.existsSync(absoluteSource)) {
        throw new Error(`node_modules source does not exist: ${absoluteSource}`);
      }
      fs.symlinkSync(absoluteSource, linkPath, "junction");
      logger(`junction node_modules -> ${absoluteSource}`);
    } else {
      logger(`installing dependencies: ${instance.installCommand}`);
      const installed = spawnSync(instance.installCommand, {
        cwd: targetDir,
        shell: true,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (installed.status !== 0) {
        throw new Error(
          `install failed: ${(installed.stderr || installed.stdout || "").trim().slice(0, 2000)}`
        );
      }
    }
  }
  return targetDir;
}

/**
 * Run the instance jest command and return the parsed per-test JSON.
 * Jest writes structured results to --outputFile so test console output
 * cannot corrupt the payload.
 */
function runProjectTests({
  instance,
  targetDir,
  outputFile,
  timeoutMs = 600_000,
  logger = () => {},
}) {
  if (fs.existsSync(outputFile)) {
    fs.rmSync(outputFile, { force: true });
  }
  const command = `npx jest ${instance.testArgs.join(" ")} --silent --json --outputFile="${path.resolve(outputFile)}"`;
  logger(`running project tests: ${command}`);
  const result = spawnSync(command, {
    cwd: targetDir,
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!fs.existsSync(outputFile)) {
    const detail = (
      result.stderr ||
      result.stdout ||
      (result.error && result.error.message) ||
      ""
    ).trim();
    throw new Error(
      `project test run produced no results file (exit ${result.status}): ${detail.slice(0, 2000)}`
    );
  }
  const parsed = JSON.parse(fs.readFileSync(outputFile, "utf8"));
  return { parsed, exitCode: result.status };
}

function gitChangedFiles(targetDir) {
  const files = new Set();
  const status = git(targetDir, ["status", "--porcelain"]);
  for (const line of status.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // Rename entries look like "R  old -> new"; the resulting file is the target.
    const raw = line.slice(3).trim();
    const target = raw.includes(" -> ") ? raw.split(" -> ").pop() : raw;
    files.add(target.replace(/\\/g, "/"));
  }
  const trackedDiff = git(targetDir, ["diff", "HEAD", "--name-only"]);
  for (const line of trackedDiff.split(/\r?\n/)) {
    if (line.trim()) files.add(line.trim().replace(/\\/g, "/"));
  }
  return [...files].sort();
}

function captureDiff(targetDir, outFile) {
  let diff = "";
  try {
    diff = git(targetDir, ["diff", "HEAD"]);
  } catch {
    diff = "";
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, diff);
  return diff;
}

module.exports = { createSandbox, runProjectTests, gitChangedFiles, captureDiff, git };

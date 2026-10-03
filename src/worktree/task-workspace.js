"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
function createTaskWorkspace(shiftHome, taskId = crypto.randomUUID()) {
  require("../shared/id-policy").assertValidOpaqueId(taskId, "taskId");
  const directory = path.join(shiftHome, "tasks", taskId);
  if (fs.existsSync(path.join(directory, ".git"))) return directory;
  fs.mkdirSync(directory, { recursive: true });
  for (const args of [
    ["init"],
    [
      "-c",
      "user.name=SHIFT",
      "-c",
      "user.email=shift@localhost",
      "commit",
      "--allow-empty",
      "-m",
      "chore(task): initialize isolated task workspace",
      "-m",
      "Establish a Git baseline for the task's isolated execution and delivery evidence.",
    ],
  ]) {
    const result = spawnSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error || result.status !== 0)
      throw new Error("无法建立任务工作区：" + (result.error?.message || result.stderr));
  }
  return directory;
}
module.exports = { createTaskWorkspace };

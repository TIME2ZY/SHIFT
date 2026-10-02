"use strict";
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { killProcessTree } = require("./windows-runtime");

function processIdentity(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "try { $ownedProcess = Get-Process -Id " +
          pid +
          " -ErrorAction Stop; $ownedProcess.StartTime.ToUniversalTime().Ticks } " +
          "catch { if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId,*') { exit 0 }; throw }",
      ],
      { encoding: "utf8", windowsHide: true }
    );
    if (result.error || result.status !== 0) throw new Error("无法核对进程身份。");
    const token = result.stdout.trim();
    return token ? { pid, token, platform } : null;
  }
  try {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, token: fields[19], platform };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function reconcileOwnedProcesses(
  entries,
  {
    identify = processIdentity,
    kill = (pid) => killProcessTree({ pid, kill: (signal) => process.kill(pid, signal) }),
    recordExit,
  } = {}
) {
  const blockers = [];
  for (const entry of entries) {
    try {
      if (!entry.identity) {
        blockers.push({ invocationId: entry.invocationId, reason: "process_identity_missing" });
        continue;
      }
      const current = identify(entry.identity.pid);
      if (
        current &&
        (current.token !== entry.identity.token || current.platform !== entry.identity.platform)
      ) {
        recordExit(entry, "pid_reused");
        continue;
      }
      if (current) {
        kill(current.pid);
        for (let i = 0; i < 100 && identify(current.pid)?.token === current.token; i++)
          await new Promise((resolve) => setTimeout(resolve, 50));
        if (identify(current.pid)?.token === current.token) {
          blockers.push({ invocationId: entry.invocationId, reason: "process_stop_unconfirmed" });
          continue;
        }
      }
      recordExit(entry, current ? "startup_terminated" : "process_already_gone");
    } catch (error) {
      blockers.push({ invocationId: entry.invocationId, reason: error.message });
    }
  }
  return blockers;
}
module.exports = { processIdentity, reconcileOwnedProcesses };

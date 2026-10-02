#!/usr/bin/env node
"use strict";
// Real CLI preparation smoke: isolated home, no submitted execution or remote publishing.
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { createServer } = require("../../src/server");
const { ROOT, createRuntimePaths } = require("../../src/shared/runtime-paths");
const { initializeRuntimeHome } = require("../../src/storage/offline/runtime-home");
const { proxyEnvVars } = require("../../src/agents/proxy");

async function main() {
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: 7897 });
    socket.setTimeout(2000);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("Local proxy unavailable; direct connection is prohibited."));
    });
  });
  const output = path.join(ROOT, "output", "live", "delegation-smoke-" + Date.now());
  const runtimePaths = createRuntimePaths({ env: { SHIFT_HOME: path.join(output, "home") } });
  initializeRuntimeHome({ runtimePaths });
  const token = crypto.randomBytes(24).toString("hex");
  const server = createServer({
    runtimePaths,
    uiToken: token,
    availabilityProbe: async (id) => ({ status: id === "codex" ? "unknown" : "unavailable" }),
    logger: { info() {}, log() {}, warn() {}, error() {} },
    spawnRunner(command, args, options) {
      return spawn(command, [args[0], "--timeout-ms", "90000", ...args.slice(1)], {
        ...options,
        env: {
          ...options.env,
          ...proxyEnvVars("http://127.0.0.1:7897"),
          NO_PROXY: "127.0.0.1,localhost",
          no_proxy: "127.0.0.1,localhost",
        },
      });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const api = async (url, method = "GET", body) => {
    const response = await fetch(base + url, {
      method,
      headers: { "X-Shift-UI-Token": token, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "API request failed");
    return result;
  };
  try {
    while ((await api("/api/tasks")).recoveryBlocked)
      await new Promise((resolve) => setTimeout(resolve, 25));
    const { task } = await api("/api/tasks", "POST", {});
    const started = await api(`/api/tasks/${task.id}/prepare`, "POST", {
      prompt:
        "请规划一个无依赖的 JavaScript CSV 导出函数。交付一个函数和单元测试；支持逗号与双引号转义。只整理目标、交付物、验收条件和分任务，不写文件。",
      clientTurnId: "smoke-prepare",
    });
    const deadline = Date.now() + 100000;
    let current;
    do {
      current = await api("/api/tasks/" + task.id);
      if (!current.preparingTaskId) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    if (current.preparingTaskId) {
      await api(`/api/tasks/${task.id}/cancel`, "POST", {});
      throw new Error("Live preparation deadline exceeded");
    }
    const { session } = await api("/api/sessions/" + started.sessionId);
    const git = spawnSync("git", ["-C", session.projectDir, "status", "--porcelain"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const { traces } = await api(`/api/sessions/${started.sessionId}/traces`);
    const platformSlotReleased = !current.busy && !current.recoveryBlocked;
    const passed =
      Boolean(current.task.contract) &&
      platformSlotReleased &&
      traces.some((trace) => trace.traceId === started.traceId && trace.state === "completed") &&
      git.status === 0 &&
      !git.stdout.trim();
    const report = {
      passed,
      selectedAgent: started.selectedAgent,
      contract: current.task.contract,
      reason: current.task.reason,
      traceStates: traces.map((trace) => trace.state),
      sourceWorkspaceUnchanged: git.status === 0 && !git.stdout.trim(),
      platformSlotReleased,
      submitted: false,
    };
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({
        passed,
        selectedAgent: started.selectedAgent,
        traceStates: report.traceStates,
        report: path.join(output, "result.json"),
      })
    );
    if (!passed) process.exitCode = 1;
  } finally {
    await server.shutdown();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

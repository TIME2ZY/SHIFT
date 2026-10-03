"use strict";
const process = require("node:process");
const { spawn } = require("node:child_process");
const { createServer } = require("../../src/server");
const { createRuntimePaths } = require("../../src/shared/runtime-paths");
const { processIdentity } = require("../../src/agents/process-ownership");
const { ENV } = require("../../src/shared/brand");

const directory = process.env.SHIFT_RECOVERY_PROJECT;
const oldIdentity = process.env.SHIFT_RECOVERY_OLD_IDENTITY
  ? JSON.parse(process.env.SHIFT_RECOVERY_OLD_IDENTITY)
  : null;
const workspace = {
  ensureWorktree: ({ sessionId }) => ({
    sessionId,
    baseDir: directory,
    worktreeDir: directory,
    branch: `codex/session-${sessionId}`,
    status: "active",
  }),
  getStatus: () => ({ headSha: "a".repeat(40), porcelain: [], clean: true }),
  getDiff: () => "",
  stopAllPreviews() {},
};
const server = createServer({
  runtimePaths: createRuntimePaths(),
  uiToken: "recovery-test",
  worktreeManager: workspace,
  embeddingAutoStart: false,
  availabilityProbe: async (id) => ({ status: id === "codex" ? "available" : "unavailable" }),
  logger: { info() {}, warn() {}, error() {}, log() {} },
  spawnRunner(command, args, options) {
    const child = spawn(
      process.execPath,
      [
        "-e",
        oldIdentity
          ? 'console.log(JSON.stringify({type:"text.delta",text:"No delivery evidence"}))'
          : "setInterval(() => {}, 1000)",
      ],
      {
        ...options,
        detached: true,
        windowsHide: true,
      }
    );
    process.send({
      kind: "spawn",
      threadId: options.env[ENV.THREAD_ID],
      pid: child.pid,
      oldIdentityStillAlive: oldIdentity
        ? processIdentity(oldIdentity.pid)?.token === oldIdentity.token
        : null,
    });
    return child;
  },
});
server.listen(0, "127.0.0.1", () => process.send({ kind: "ready", port: server.address().port }));
process.on("message", async (message) => {
  if (message === "shutdown") {
    await server.shutdown();
    process.disconnect();
  }
});

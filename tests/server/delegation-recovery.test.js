"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStorage } = require("../../src/storage");
const { createRuntimePaths } = require("../../src/shared/runtime-paths");
const { initializeRuntimeHome } = require("../../src/storage/offline/runtime-home");
const { processIdentity, reconcileOwnedProcesses } = require("../../src/agents/process-ownership");

const contract = {
  workflowId: "software_delivery",
  goal: "Add export",
  deliverables: ["export"],
  acceptanceCriteria: ["valid data"],
  subtasks: [{ id: "export", title: "Export", description: "Export data" }],
};
async function waitFor(read, predicate) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Recovery did not settle");
}

test(
  "hard server crash closes orphan process and resumes durable FIFO without repeating interrupted task",
  { timeout: 45000 },
  async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shift-process-recovery-"));
    const paths = createRuntimePaths({ env: { SHIFT_HOME: path.join(directory, "home") } });
    initializeRuntimeHome({ runtimePaths: paths });
    const children = [];
    let orphanIdentity;
    t.after(async () => {
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const exit = once(child, "exit");
        child.kill("SIGKILL");
        await exit;
      }
      if (orphanIdentity)
        await reconcileOwnedProcesses(
          [{ invocationId: "test-cleanup", identity: orphanIdentity }],
          { recordExit() {} }
        );
      // Absolute, uniquely created test directory; never a user project.
      fs.rmSync(directory, { recursive: true, force: true });
    });
    async function start(oldIdentity) {
      const messages = [];
      const child = fork(path.join(__dirname, "../fixtures/delegation-recovery-server.cjs"), [], {
        env: {
          ...process.env,
          SHIFT_HOME: paths.shiftHome,
          SHIFT_RECOVERY_PROJECT: directory,
          SHIFT_RECOVERY_OLD_IDENTITY: oldIdentity ? JSON.stringify(oldIdentity) : "",
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        windowsHide: true,
      });
      children.push(child);
      let diagnostic = "";
      child.stderr.on("data", (chunk) => {
        diagnostic += chunk;
      });
      child.on("message", (message) => messages.push(message));
      const ready = await waitFor(() => {
        if (child.exitCode !== null) throw new Error(diagnostic || "Server exited before startup");
        return messages.find((message) => message.kind === "ready");
      }, Boolean);
      const api = async (suffix, method = "GET", body) => {
        const response = await fetch(`http://127.0.0.1:${ready.port}` + suffix, {
          method,
          headers: { "X-Shift-UI-Token": "recovery-test", "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const result = await response.json();
        assert.ok(response.ok, result.error);
        return result;
      };
      await waitFor(
        () => api("/api/tasks"),
        (state) => !state.recoveryBlocked
      );
      return { child, api, messages };
    }
    const first = await start();
    const project = await first.api("/api/projects/open", "POST", { dir: directory });
    const ids = [];
    for (let index = 0; index < 2; index++) {
      const { task } = await first.api("/api/tasks", "POST", {
        projectKey: project.project.projectKey,
      });
      ids.push(task.threadId);
      const saved = await first.api(`/api/tasks/${task.threadId}`, "PATCH", {
        contract,
        expectedRevision: task.version,
      });
      await first.api(`/api/tasks/${task.threadId}/submit`, "POST", {
        expectedRevision: saved.task.version,
      });
    }
    await waitFor(
      () => first.messages.filter((message) => message.kind === "spawn"),
      (messages) => messages.length === 1
    );
    const storage = createStorage({ file: paths.databaseFile });
    try {
      const owners = await waitFor(
        () => storage.processOwnership.listOpen(),
        (owners) => owners.some((owner) => owner.identity)
      );
      orphanIdentity = owners[0].identity;
      assert.equal(storage.collaborationTasks.get(ids[1]).delegationState, "queued");
    } finally {
      storage.close();
    }
    const crashed = once(first.child, "exit");
    first.child.kill("SIGKILL");
    await crashed;
    assert.equal(processIdentity(orphanIdentity.pid)?.token, orphanIdentity.token);

    const second = await start(orphanIdentity);
    const settled = await waitFor(
      () => second.api(`/api/tasks/${ids[1]}`),
      (state) => state.task.delegationState === "failed"
    );
    assert.equal(settled.task.queueSeq, 2);
    const interrupted = (await second.api(`/api/tasks/${ids[0]}`)).task;
    assert.equal(interrupted.delegationState, "failed");
    assert.equal(interrupted.delegationReason, "application_interrupted");
    assert.equal(processIdentity(orphanIdentity.pid)?.token === orphanIdentity.token, false);
    const spawned = second.messages.filter((message) => message.kind === "spawn");
    assert.ok(spawned.length > 0);
    assert.ok(
      spawned.every((message) => message.threadId === ids[1] && !message.oldIdentityStillAlive)
    );
    const recoveredStorage = createStorage({ file: paths.databaseFile });
    try {
      assert.deepEqual(recoveredStorage.processOwnership.listOpen(), []);
      assert.equal(
        recoveredStorage.db
          .prepare("SELECT COUNT(*) AS n FROM invocations WHERE state = 'active'")
          .get().n,
        0
      );
      const exit = recoveredStorage.db
        .prepare(
          "SELECT e.payload_json FROM invocation_events e JOIN invocations i ON i.id = e.invocation_id WHERE i.thread_id = ? AND e.kind = 'process.exited'"
        )
        .get(ids[0]);
      assert.equal(JSON.parse(exit.payload_json).reason, "startup_terminated");
    } finally {
      recoveredStorage.close();
    }
    const stopped = once(second.child, "exit");
    second.child.send("shutdown");
    await stopped;
  }
);

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { processIdentity, reconcileOwnedProcesses } = require("../../src/agents/process-ownership");
test("current process has stable identity and invalid PID never targets a process", () => {
  assert.deepEqual(processIdentity(process.pid), processIdentity(process.pid));
  assert.equal(processIdentity(-1), null);
  assert.equal(processIdentity("1;exit"), null);
});
test("confirmed exited process is absent rather than an identity lookup failure", () => {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true });
  assert.equal(child.status, 0);
  assert.equal(processIdentity(child.pid), null);
});
test("recovery never kills reused PIDs or unidentified process and records confirmed exits", async () => {
  const killed = [],
    exited = [];
  const identity = { pid: 123, token: "old", platform: process.platform };
  const blockers = await reconcileOwnedProcesses(
    [
      { invocationId: "unknown", identity: null },
      { invocationId: "reused", identity },
      { invocationId: "gone", identity: { ...identity, pid: 124 } },
    ],
    {
      identify: (pid) => (pid === 123 ? { ...identity, token: "new" } : null),
      kill: (pid) => killed.push(pid),
      recordExit: (entry, reason) => exited.push([entry.invocationId, reason]),
    }
  );
  assert.deepEqual(killed, []);
  assert.equal(blockers[0].reason, "process_identity_missing");
  assert.deepEqual(exited, [
    ["reused", "pid_reused"],
    ["gone", "process_already_gone"],
  ]);
});
test("recovery kills only matching identity and persistence failure keeps queue blocked", async () => {
  const identity = { pid: 123, token: "old", platform: process.platform };
  let alive = true;
  const blockers = await reconcileOwnedProcesses([{ invocationId: "owned", identity }], {
    identify: () => (alive ? identity : null),
    kill: (pid) => {
      assert.equal(pid, 123);
      alive = false;
    },
    recordExit: () => {
      throw new Error("SQLite unavailable");
    },
  });
  assert.equal(blockers[0].reason, "SQLite unavailable");
});

"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { createSoftwareDeliveryTeam } = require("../../src/teams/software-delivery");
test("a trace-binding failure stops and awaits the owned executor before returning failure", async () => {
  let release,
    stopped = false,
    settled = false;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  const team = createSoftwareDeliveryTeam({
    startRun: async () => ({ ok: true, json: { traceId: "trace" }, promise }),
    getSession: () => ({ messages: [] }),
    createSession: () => ({ id: "thread" }),
    projects: { requireActive: () => ({ projectKey: "project", canonicalPath: "dir" }) },
    workspace: {
      ensureWorktree: () => ({ worktreeDir: "worktree" }),
      getStatus: () => ({ headSha: "a".repeat(40), porcelain: [] }),
    },
    setSessionWorktree() {},
    runtime: {
      runs: new Map([["thread", { traceId: "trace" }]]),
      stopRun() {
        stopped = true;
      },
    },
  });
  const claim = {
    id: "run",
    task: { id: "task", projectKey: "project", contract: { goal: "goal" }, nodes: [] },
    node: {
      id: "node",
      description: "goal",
      deliverables: ["code"],
      acceptanceCriteria: ["tested"],
    },
    team: { bindings: { discuss: { providerId: "codex" } } },
    attempt: 1,
    inputs: [],
  };
  const execution = team.execute(claim, {
    signal: new AbortController().signal,
    bind(binding) {
      if (binding.traceId)
        throw Object.assign(new Error("binding write failed"), { code: "BIND_FAILED" });
    },
  });
  void execution.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, true);
  assert.equal(settled, false);
  release();
  await assert.rejects(execution, { code: "BIND_FAILED" });
});

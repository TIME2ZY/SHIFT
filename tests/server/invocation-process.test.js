const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MAX_TOOL_DETAIL_CHARS,
  projectInvocationProcess,
} = require("../../src/server/invocation-process");

test("projectInvocationProcess restores thinking, tools, progress, and changed files", () => {
  const process = projectInvocationProcess("i1", [
    { eventNo: 0, kind: "text.delta", payload: { text: "先说明。" } },
    { eventNo: 4, kind: "thinking.delta", payload: { text: "B" } },
    {
      eventNo: 2,
      kind: "tool.started",
      ts: "2026-07-31T00:00:00.000Z",
      payload: { toolId: "t1", toolName: "command_execution", args: { command: "npm test" } },
    },
    { eventNo: 1, kind: "thinking.delta", payload: { text: "A" } },
    {
      eventNo: 3,
      kind: "tool.finished",
      ts: "2026-07-31T00:00:02.000Z",
      payload: { toolId: "t1", toolName: "command_execution", result: { ok: true } },
    },
    {
      eventNo: 6,
      kind: "progress.update",
      payload: { items: [{ id: "p1", text: "测试", status: "completed" }] },
    },
    {
      eventNo: 7,
      kind: "file.changed",
      payload: { path: "web/src/App.tsx", changeType: "modified" },
    },
    { eventNo: 5, kind: "text.delta", payload: { text: "最后回答。" } },
    { eventNo: 8, kind: "run.finished", payload: { exitCode: 0 } },
  ]);

  assert.equal(process.status, "done");
  assert.equal(process.thinking.text, "AB");
  assert.deepEqual(process.tools[0], {
    toolId: "t1",
    toolName: "command_execution",
    status: "done",
    input: { command: "npm test" },
    output: '{\n  "ok": true\n}',
    startedAt: "2026-07-31T00:00:00.000Z",
    finishedAt: "2026-07-31T00:00:02.000Z",
    durationMs: 2000,
    changedFiles: [],
  });
  assert.deepEqual(process.timeline, [
    {
      id: "text-0",
      type: "text",
      eventNo: 0,
      lastEventNo: 0,
      text: "先说明。",
    },
    {
      id: "thinking-1",
      type: "thinking",
      eventNo: 1,
      lastEventNo: 1,
      text: "A",
    },
    { id: "tool-t1", type: "tool", eventNo: 2, toolId: "t1" },
    {
      id: "thinking-4",
      type: "thinking",
      eventNo: 4,
      lastEventNo: 4,
      text: "B",
    },
    {
      id: "text-5",
      type: "text",
      eventNo: 5,
      lastEventNo: 5,
      text: "最后回答。",
    },
  ]);
  assert.deepEqual(process.progress, [{ id: "p1", label: "测试", status: "completed" }]);
  assert.deepEqual(process.changedFiles, [{ path: "web/src/App.tsx", changeType: "modified" }]);
});

test("projectInvocationProcess keeps orphan finishes and truncates large output", () => {
  const process = projectInvocationProcess("i2", [
    {
      eventNo: 1,
      kind: "tool.finished",
      payload: {
        toolId: "orphan",
        toolName: "read",
        status: "failed",
        error: "x".repeat(MAX_TOOL_DETAIL_CHARS + 20),
      },
    },
    { eventNo: 2, kind: "run.failed", payload: { error: "failed" } },
  ]);

  assert.equal(process.status, "error");
  assert.equal(process.tools[0].status, "error");
  assert.equal(process.tools[0].outputTruncated, true);
  assert.match(process.tools[0].error, /输出已截断/);
});

test("projectInvocationProcess reads the durable invocation-end code", () => {
  const completed = projectInvocationProcess("i3", [
    { eventNo: 1, kind: "invocation-end", payload: { code: 0, signal: null } },
  ]);
  const failed = projectInvocationProcess("i4", [
    { eventNo: 1, kind: "invocation-end", payload: { code: 1, signal: null } },
  ]);
  const failedBeforeCleanExit = projectInvocationProcess("i5", [
    { eventNo: 1, kind: "run.failed", payload: { error: "provider failed" } },
    { eventNo: 2, kind: "invocation-end", payload: { code: 0, signal: null } },
  ]);

  assert.equal(completed.status, "done");
  assert.equal(failed.status, "error");
  assert.equal(failedBeforeCleanExit.status, "error");
});

test("projectInvocationProcess repairs legacy tool status without failing the agent run", () => {
  const process = projectInvocationProcess("i6", [
    {
      eventNo: 1,
      kind: "tool.finished",
      payload: {
        toolId: "legacy-fatal",
        toolName: "bash",
        status: "ok",
        exitCode: 0,
        output: "pull request create failed: GraphQL: Resource not accessible",
      },
    },
    { eventNo: 2, kind: "run.finished", payload: { exitCode: 0 } },
  ]);

  assert.equal(process.status, "done");
  assert.equal(process.tools[0].status, "error");
  assert.equal(process.tools[0].failureSource, "output-signature");
  assert.match(process.tools[0].error, /pull request create failed/);
});

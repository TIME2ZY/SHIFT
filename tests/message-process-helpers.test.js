const { test } = require("node:test");
const assert = require("node:assert/strict");
const helpers = require("../public/message-process-helpers.js");

test("truncateDisplay and collapseWs", () => {
  assert.equal(helpers.collapseWs(" a  b\n"), "a b");
  assert.equal(helpers.truncateDisplay("x".repeat(10), 5).length, 5);
});

test("toolDetailFromEvent prefers path aliases including filePath", () => {
  assert.match(
    helpers.toolDetailFromEvent({
      toolName: "read",
      args: { filePath: "src/app.js" },
    }),
    /src\/app\.js/
  );
  assert.match(
    helpers.toolDetailFromEvent({
      toolName: "bash",
      args: { command: "npm test" },
    }),
    /npm test/
  );
});

test("cleanProcessOutput strips task XML", () => {
  const out = helpers.cleanProcessOutput("<task_result>ok done</task_result>");
  assert.match(out, /ok done/);
});

test("isTaskLikeTool detects subagent task tools", () => {
  assert.equal(helpers.isTaskLikeTool({ toolName: "task" }), true);
  assert.equal(helpers.isTaskLikeTool({ toolName: "read", args: {} }), false);
  assert.equal(helpers.isTaskLikeTool({ toolName: "x", args: { subagent_type: "explore" } }), true);
});

test("progress helpers", () => {
  assert.equal(helpers.progressItemDone({ status: "done" }), true);
  assert.equal(helpers.progressItemLabel({ text: "step" }), "step");
});

test("resolveCapabilities defaults optimistically when missing", () => {
  const caps = helpers.resolveCapabilities(null);
  assert.equal(caps.thinking, true);
  assert.equal(caps.tools, true);
  assert.equal(caps.subagents, undefined);
});

test("resolveCapabilities respects explicit false flags", () => {
  const caps = helpers.resolveCapabilities({
    capabilities: { thinking: false, tools: false, resume: true },
  });
  assert.equal(helpers.shouldRenderThinking(caps), false);
  assert.equal(helpers.shouldRenderTools(caps), false);
});

test("findAgentCapabilities looks up agent list by id", () => {
  const agents = [
    { id: "codex", capabilities: { thinking: false, tools: true } },
    { id: "grok", capabilities: { thinking: true, tools: false } },
  ];
  assert.equal(helpers.findAgentCapabilities(agents, "codex").thinking, false);
  assert.equal(helpers.findAgentCapabilities(agents, "grok").tools, false);
  assert.equal(helpers.findAgentCapabilities(agents, "missing").thinking, true);
});

test("capabilityTagList is capability-driven not provider-name hardcoding", () => {
  assert.deepEqual(
    helpers.capabilityTagList({
      capabilities: { thinking: true, tools: false },
    }),
    ["思考"]
  );
  assert.deepEqual(
    helpers.capabilityTagList({
      capabilities: { thinking: true, tools: true },
    }),
    ["思考", "工具"]
  );
});

test("aggregateProcessBuckets merges durable tool started/finished by toolId", () => {
  const buckets = helpers.aggregateProcessBuckets([
    {
      kind: "tool.started",
      payload: { toolId: "t1", toolName: "read", args: { path: "a.js" } },
    },
    {
      kind: "tool.finished",
      payload: { toolId: "t1", toolName: "read", result: "ok", status: "done" },
    },
    {
      kind: "text.delta",
      payload: { text: "hello " },
    },
    {
      kind: "subagent.started",
      payload: { subagentId: "s1", name: "explore", task: "find files" },
    },
    {
      kind: "subagent.completed",
      payload: { subagentId: "s1", name: "explore", summary: "done" },
    },
    {
      kind: "command.started",
      payload: { command: "npm test" },
    },
    {
      kind: "command.finished",
      payload: { command: "npm test", exitCode: 0 },
    },
  ]);

  // Legacy subagent.* + command.* fold into toolById (s1 + t1 + npm test).
  assert.equal(buckets.toolById.size, 3);
  const tool = buckets.toolById.get("t1");
  assert.equal(tool.toolName, "read");
  assert.equal(tool.result, "ok");
  assert.equal(tool.type, "tool.finished");

  assert.equal(buckets.subById.size, 0);
  assert.equal(buckets.commandByKey.size, 0);
  const legacy = buckets.toolById.get("s1");
  assert.equal(legacy.type, "tool.finished");
  assert.equal(legacy.toolName, "explore");
  assert.equal(legacy.result, "done");

  const cmd = buckets.toolById.get("npm test");
  assert.equal(cmd.toolName, "command_execution");
  assert.equal(cmd.exitCode, 0);
  assert.equal(helpers.isProcessBucketsEmpty(buckets), false);
});

test("aggregateProcessBuckets accepts flat live-shaped events", () => {
  const buckets = helpers.aggregateProcessBuckets([
    { type: "tool.started", toolId: "x", toolName: "grep", args: { pattern: "foo" } },
    { type: "tool.finished", toolId: "x", toolName: "grep", result: [] },
  ]);
  assert.equal(buckets.toolById.size, 1);
  assert.equal(buckets.toolById.get("x").type, "tool.finished");
});

test("aggregateProcessBuckets renders visible diagnostics and skips hidden ones", () => {
  const buckets = helpers.aggregateProcessBuckets([
    {
      type: "diagnostic",
      code: "model_refresh",
      fingerprint: "codex:model-refresh",
      message: "模型列表刷新超时",
      severity: "diagnostic",
      visibility: "details",
      count: 4,
    },
    {
      type: "diagnostic",
      code: "stdin_notice",
      fingerprint: "codex:stdin",
      message: "Reading additional input",
      severity: "debug",
      visibility: "hidden",
    },
  ]);
  assert.equal(buckets.toolById.size, 1);
  const diagnostic = buckets.toolById.get("codex:model-refresh");
  assert.equal(diagnostic.toolName, "诊断 × 4");
  assert.equal(diagnostic.args.description, "模型列表刷新超时");
  assert.equal(diagnostic._traceKind, "diagnostic");
});

test("textDeltaSummary concatenates and truncates text.delta", () => {
  const summary = helpers.textDeltaSummary(
    [
      { kind: "text.delta", payload: { text: "alpha " } },
      { kind: "tool.started", payload: { toolName: "x" } },
      { kind: "text.delta", payload: { text: "beta" } },
      { kind: "text.final", payload: { text: "!" } },
    ],
    200
  );
  assert.match(summary, /alpha/);
  assert.match(summary, /beta/);
  assert.equal(helpers.isProcessBucketsEmpty(helpers.aggregateProcessBuckets([])), true);
});

test("aggregateProcessBuckets tracks _eventNos for Phase B focus", () => {
  const buckets = helpers.aggregateProcessBuckets([
    {
      eventNo: 3,
      kind: "tool.started",
      payload: { toolId: "t9", toolName: "read", args: { path: "x" } },
    },
    {
      eventNo: 4,
      kind: "tool.finished",
      payload: { toolId: "t9", toolName: "read", result: "ok" },
    },
  ]);
  const tool = buckets.toolById.get("t9");
  assert.deepEqual(tool._eventNos, [3, 4]);
  assert.equal(tool._traceKind, "tool");
  assert.equal(tool._traceId, "t9");
});

test("processAnchorFromEvent maps tool/legacy-subagent/command", () => {
  assert.deepEqual(
    helpers.processAnchorFromEvent({
      kind: "tool.started",
      payload: { toolId: "a", toolName: "grep" },
    }),
    { rowKind: "tool", rowId: "a" }
  );
  assert.deepEqual(
    helpers.processAnchorFromEvent({
      kind: "subagent.completed",
      payload: { subagentId: "s2", name: "explore" },
    }),
    { rowKind: "tool", rowId: "s2" }
  );
  assert.deepEqual(
    helpers.processAnchorFromEvent({
      kind: "command.finished",
      payload: { command: "npm test", exitCode: 0 },
    }),
    { rowKind: "tool", rowId: "npm test" }
  );
  assert.equal(
    helpers.processAnchorFromEvent({ kind: "text.delta", payload: { text: "hi" } }),
    null
  );
});

test("stampEventNos fills absolute indexes", () => {
  const stamped = helpers.stampEventNos([{ kind: "a" }, { kind: "b", eventNo: 99 }], 10);
  assert.equal(stamped[0].eventNo, 10);
  assert.equal(stamped[1].eventNo, 99);
});

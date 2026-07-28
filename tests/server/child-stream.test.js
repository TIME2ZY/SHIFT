const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { runChildStream, filterBenignStderr } = require("../../src/server/child-stream");

test("child stream removes abort and response listeners after exit", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const res = new EventEmitter();
  res.write = () => {};
  const controller = new AbortController();

  const completed = runChildStream({
    spawnRunner: () => child,
    args: [],
    res,
    signal: controller.signal,
    onStdout() {},
    onStderr() {},
  });
  assert.equal(res.listenerCount("close"), 1);
  child.emit("close", 0, null);

  const result = await completed;
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.ok(result.encoding);
  assert.equal(result.encoding.total, 0);
  assert.equal(res.listenerCount("close"), 0);
});

test("stderr filter removes known startup noise only", () => {
  const input = [
    "Reading additional input from stdin...",
    "2026-01-01T00:00:00 WARN codex_core_plugins::manifest: ignoring duplicate",
    "real failure",
  ].join("\n");
  assert.equal(filterBenignStderr(input), "real failure");
});

test("child stream preserves UTF-8 split across stdout and stderr chunks", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const res = new EventEmitter();
  res.write = () => {};
  const events = [];
  let stderr = "";
  const completed = runChildStream({
    spawnRunner: () => child,
    args: [],
    res,
    onStdout() {},
    onEvent: (event) => events.push(event),
    onStderr: (text) => {
      stderr += text;
    },
  });

  const stdout = Buffer.from('{"type":"text.delta","text":"中文回调"}\n', "utf8");
  const stdoutSplit = stdout.indexOf(Buffer.from("中")) + 1;
  child.stdout.emit("data", stdout.subarray(0, stdoutSplit));
  child.stdout.emit("data", stdout.subarray(stdoutSplit));

  const stderrBytes = Buffer.from("错误信息", "utf8");
  child.stderr.emit("data", stderrBytes.subarray(0, 2));
  child.stderr.emit("data", stderrBytes.subarray(2));
  child.emit("close", 0, null);

  await completed;
  assert.deepEqual(events, [{ type: "text.delta", text: "中文回调" }]);
  assert.equal(stderr, "错误信息");
  assert.doesNotMatch(`${events[0].text}${stderr}`, /�/);
});

test("child stream parses the final event without a trailing newline", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const res = new EventEmitter();
  res.write = () => {};
  const events = [];
  const completed = runChildStream({
    spawnRunner: () => child,
    args: [],
    res,
    onStdout() {},
    onEvent: (event) => events.push(event),
    onStderr() {},
  });

  child.stdout.emit("data", Buffer.from('{"type":"text.delta","text":"完成"}', "utf8"));
  child.emit("close", 0, null);

  await completed;
  assert.deepEqual(events, [{ type: "text.delta", text: "完成" }]);
});

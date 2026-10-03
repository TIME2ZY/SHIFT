"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const { runChildStream } = require("../../src/server/child-stream");
const { contentHash } = require("../../src/tasks/files");
test("large UTF-8 prompts cross the real runner pipe without Windows command-line expansion", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shift-pipe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, "runner.js");
  fs.writeFileSync(
    script,
    'const c=[];process.stdin.on("data",x=>c.push(x));process.stdin.on("end",()=>console.log(JSON.stringify({type:"text.delta",text:require("node:crypto").createHash("sha256").update(Buffer.concat(c)).digest("hex")})));'
  );
  const prompt = "材料\r\n".repeat(10000),
    events = [];
  const result = await runChildStream({
    args: [script, prompt],
    cwd: dir,
    onEvent: (event) => events.push(event),
    spawnRunner(command, args, options) {
      assert.deepEqual(args, [script, "--prompt-stdin"]);
      assert.equal(options.stdio[0], "pipe");
      return spawn(command, args, options);
    },
  });
  assert.equal(result.code, 0);
  assert.equal(
    events.find((event) => event.type === "text.delta").text,
    contentHash(Buffer.from(prompt))
  );
});
test("an input pipe write failure stops the runner and cannot return a successful stream", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("input lost"));
    },
  });
  child.kill = () => {
    process.nextTick(() => child.emit("close", 0, null));
    return true;
  };
  const result = await runChildStream({
    args: ["runner", "x".repeat(20000)],
    spawnRunner: () => child,
    onEvent() {},
    onError() {},
  });
  assert.equal(result.streamError.origin, "stdin stream");
  assert.equal(result.streamError.message, "input lost");
});

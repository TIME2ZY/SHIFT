"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { createStorage } = require("../../src/storage");
const { createTaskFiles, contentHash } = require("../../src/tasks/files");
const { contract, team } = require("../helpers/task-plan");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shift-inputs-"));
  const s = createStorage({ file: ":memory:" }),
    files = createTaskFiles({ shiftHome: dir });
  t.after(() => {
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { s, files, dir };
}
test("snapshots canonicalize bytes and freeze CAS references, including inherited ownership", (t) => {
  const { s, files } = fixture(t);
  const task = s.tasks.create(),
    raw = "\uFEFF原文\r\n第二行\r";
  const input = files.storeInput(task.id, { name: "source.md", content: raw });
  assert.equal(input.contentHash, contentHash(Buffer.from("原文\n第二行\n")));
  const added = s.tasks.addInput(task.id, input, task.revision);
  assert.throws(() => s.tasks.addInput(task.id, input, task.revision), {
    code: "TASK_REVISION_CONFLICT",
  });
  const saved = s.tasks.saveDraft(task.id, contract, added.revision);
  const published = s.tasks.submit(task.id, saved.revision, { first: team });
  const child = s.tasks.create({ parentTaskId: task.id });
  assert.deepEqual(child.inputs, published.inputs);
  assert.equal(child.inputs[0].ownerTaskId, task.id);
  assert.deepEqual(files.readInputs(child.inputs)[0].lines, ["原文", "第二行", ""]);
  assert.throws(() => s.tasks.removeInput(task.id, added.inputs[0].id, published.revision), {
    code: "TASK_FROZEN",
  });
  const removed = s.tasks.removeInput(child.id, child.inputs[0].id, child.revision);
  assert.deepEqual(removed.inputs, []);
  assert.deepEqual(s.tasks.get(task.id).inputs, published.inputs);
  fs.writeFileSync(input.locator, "changed");
  assert.throws(() => files.readInputs(published.inputs), { code: "CONTENT_CHANGED" });
});
test("input limits and managed paths reject traversal, cross-owner references and links", (t) => {
  const { s, files, dir } = fixture(t);
  let task = s.tasks.create();
  assert.throws(() => files.storeInput(task.id, { name: "large", content: "x".repeat(65537) }), {
    code: "INPUT_LIMIT",
  });
  const item = files.storeInput(task.id, { name: "source", content: "x".repeat(65536) });
  for (let i = 0; i < 4; i++) task = s.tasks.addInput(task.id, item, task.revision);
  assert.throws(() => s.tasks.addInput(task.id, item, task.revision), { code: "INPUT_LIMIT" });
  assert.throws(() => files.directory("../outside"), /taskId/);
  assert.throws(() => files.readInputs([{ ...task.inputs[0], ownerTaskId: "different-task" }]), {
    code: "UNSAFE_TASK_PATH",
  });
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(
    outside,
    path.join(dir, "tasks", "linked"),
    process.platform === "win32" ? "junction" : "dir"
  );
  assert.throws(() => files.storeInput("linked", { name: "source", content: "body" }), {
    code: "UNSAFE_TASK_PATH",
  });
  assert.deepEqual(fs.readdirSync(outside), []);
});

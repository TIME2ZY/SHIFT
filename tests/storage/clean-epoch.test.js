const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const { prepareCleanEpoch } = require("../../src/storage/clean-epoch");

test("prepare clean epoch creates and activates a new empty SQLite target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shift-clean-epoch-"));
  const file = path.join(root, "new", "storage.sqlite");
  try {
    const result = prepareCleanEpoch({
      file,
      cutoverTime: "2026-07-26T08:00:00.000Z",
    });
    assert.equal(result.integrity.ok, true);
    assert.equal(result.epoch.dataPolicy, "clean");
    assert.equal(result.epoch.isActive, true);
    assert.equal(result.epoch.cutoverTime, "2026-07-26T08:00:00.000Z");

    const reopened = createStorage({ file });
    try {
      assert.equal(reopened.metadata.getCurrent().epochId, result.epoch.epochId);
      assert.equal(reopened.threads.list().length, 0);
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prepare clean epoch refuses every existing SQLite target family member", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shift-clean-existing-"));
  const file = path.join(root, "storage.sqlite");
  fs.writeFileSync(`${file}-wal`, "existing");
  try {
    assert.throws(() => prepareCleanEpoch({ file }), /must not already exist/);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readFileSync(`${file}-wal`, "utf8"), "existing");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const {
  buildLegacyCleanupManifest,
  readEpochMetadata,
} = require("../../src/storage/legacy-cleanup-manifest");

test("legacy cleanup manifest is read-only and inventories explicit targets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shift-cleanup-manifest-"));
  const sessionsFile = path.join(root, "sessions.json");
  const transcriptDir = path.join(root, "transcripts");
  fs.writeFileSync(sessionsFile, '{"sessions":[]}');
  fs.mkdirSync(transcriptDir);
  fs.writeFileSync(path.join(transcriptDir, "event.jsonl"), '{"kind":"old"}\n');

  try {
    const manifest = buildLegacyCleanupManifest({
      generatedAt: "2026-07-26T00:00:00.000Z",
      epoch: {
        epochId: "legacy-1",
        schemaVersion: 13,
        dataPolicy: "legacy-validation",
        cutoverTime: null,
        isActive: false,
      },
      paths: {
        sessionsFile,
        invocationsFile: path.join(root, "invocations.json"),
        transcriptDir,
        sessionMapRoot: path.join(root, "session-maps"),
        memoryDbFile: path.join(root, "memory.sqlite"),
      },
    });

    assert.equal(manifest.action, "plan-only");
    assert.equal(manifest.destructive, false);
    assert.equal(manifest.readyToDelete, false);
    assert.equal(manifest.targets.length, 7);
    assert.equal(manifest.totals.existing, 2);
    assert.equal(manifest.totals.files, 2);
    assert.ok(manifest.totals.bytes > 0);
    assert.ok(manifest.targets.every((item) => item.deletePolicy === "explicit-post-cutover-only"));
    assert.equal(fs.existsSync(sessionsFile), true);
    assert.equal(fs.existsSync(transcriptDir), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("clean epoch manifest never schedules the authoritative database for deletion", () => {
  const manifest = buildLegacyCleanupManifest({
    epoch: {
      epochId: "epoch-1",
      schemaVersion: 13,
      dataPolicy: "clean",
      cutoverTime: "2026-07-26T00:00:00.000Z",
      isActive: true,
    },
    paths: {
      sessionsFile: "sessions.json",
      memoryDbFile: "memory.sqlite",
    },
  });
  assert.equal(
    manifest.targets.some((item) => item.id === "legacy-validation-db"),
    false
  );
  assert.deepEqual(manifest.dataRange, {
    before: "2026-07-26T00:00:00.000Z",
    inclusive: false,
  });
});

test("epoch inspection opens SQLite read-only without changing the database", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shift-cleanup-epoch-"));
  const databaseFile = path.join(root, "memory.sqlite");
  const storage = createStorage({ file: databaseFile });
  const expected = storage.metadata.getCurrent();
  storage.close();
  const before = fs.statSync(databaseFile);
  try {
    const epoch = readEpochMetadata(databaseFile);
    const after = fs.statSync(databaseFile);
    assert.equal(epoch.epochId, expected.epochId);
    assert.equal(epoch.schemaVersion, expected.schemaVersion);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.size, before.size);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

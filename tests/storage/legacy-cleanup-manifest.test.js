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
        epochId: "clean-1",
        schemaVersion: 13,
        dataPolicy: "clean",
        cutoverTime: "2026-07-25T00:00:00.000Z",
        isActive: true,
      },
      paths: {
        authoritativeDbFile: path.join(root, "shift.sqlite"),
        sessionsFile,
        invocationsFile: path.join(root, "invocations.json"),
        transcriptDir,
        auditTranscriptDir: path.join(root, "audit-transcripts"),
        sessionMapRoot: path.join(root, "session-maps"),
        legacyDbFile: path.join(root, "memory.sqlite"),
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
    assert.equal(manifest.protectedPaths[0].id, "authoritative-db");
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
      authoritativeDbFile: "shift.sqlite",
      sessionsFile: "sessions.json",
      legacyDbFile: "memory.sqlite",
    },
  });
  assert.equal(
    manifest.targets.some(
      (item) =>
        item.id === "legacy-validation-db" &&
        item.path === path.resolve("memory.sqlite")
    ),
    true
  );
  assert.equal(
    manifest.targets.some((item) => item.path === path.resolve("shift.sqlite")),
    false
  );
  assert.deepEqual(manifest.dataRange, {
    before: "2026-07-26T00:00:00.000Z",
    inclusive: false,
  });
});

test("cleanup manifest rejects the authoritative database as a legacy target", () => {
  const databaseFile = path.resolve("shift.sqlite");
  assert.throws(
    () =>
      buildLegacyCleanupManifest({
        epoch: {
          epochId: "epoch-1",
          schemaVersion: 13,
          dataPolicy: "clean",
          cutoverTime: "2026-07-26T00:00:00.000Z",
          isActive: true,
        },
        paths: {
          authoritativeDbFile: databaseFile,
          legacyDbFile: databaseFile,
        },
      }),
    /overlaps protected authoritative-db/
  );
});

test("cleanup manifest protects authoritative SQLite WAL and SHM sidecars", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shift-cleanup-sidecars-"));
  const databaseFile = path.join(root, "shift.sqlite");
  try {
    for (const suffix of ["-wal", "-shm"]) {
      assert.throws(
        () =>
          buildLegacyCleanupManifest({
            epoch: {
              epochId: "epoch-1",
              schemaVersion: 13,
              dataPolicy: "clean",
              cutoverTime: "2026-07-26T00:00:00.000Z",
              isActive: true,
            },
            paths: {
              authoritativeDbFile: databaseFile,
              legacyDbFile: `${databaseFile}${suffix}`,
            },
          }),
        /overlaps protected authoritative-db-(wal|shm)/
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup manifest rejects overlapping audit and legacy transcript directories", () => {
  const transcriptDir = path.resolve("transcripts");
  assert.throws(
    () =>
      buildLegacyCleanupManifest({
        epoch: {
          epochId: "epoch-1",
          schemaVersion: 13,
          dataPolicy: "clean",
          cutoverTime: "2026-07-26T00:00:00.000Z",
          isActive: true,
        },
        paths: {
          authoritativeDbFile: path.resolve("shift.sqlite"),
          transcriptDir,
          auditTranscriptDir: transcriptDir,
        },
      }),
    /overlaps protected canonical-audit/
  );
});

test("cleanup manifest blocks a legacy transcript directory containing canonical audit events", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shift-cleanup-mixed-"));
  const transcriptDir = path.join(root, "transcripts");
  fs.mkdirSync(transcriptDir);
  fs.writeFileSync(
    path.join(transcriptDir, "mixed.jsonl"),
    `${JSON.stringify({ eventId: "evt-1", kind: "text.delta" })}\n`
  );
  try {
    assert.throws(
      () =>
        buildLegacyCleanupManifest({
          epoch: {
            epochId: "epoch-1",
            schemaVersion: 13,
            dataPolicy: "clean",
            cutoverTime: "2026-07-26T00:00:00.000Z",
            isActive: true,
          },
          paths: {
            authoritativeDbFile: path.join(root, "shift.sqlite"),
            transcriptDir,
            auditTranscriptDir: path.join(root, "audit-transcripts"),
          },
        }),
      /canonical audit events were found/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup manifest accepts a mixed transcript only after protected archive coverage", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shift-cleanup-covered-mixed-"));
  const transcriptDir = path.join(root, "transcripts");
  fs.mkdirSync(transcriptDir);
  fs.writeFileSync(
    path.join(transcriptDir, "mixed.jsonl"),
    `${JSON.stringify({ eventId: "evt-1", kind: "text.delta" })}\n`
  );
  try {
    const manifest = buildLegacyCleanupManifest({
      epoch: {
        epochId: "epoch-1",
        schemaVersion: 13,
        dataPolicy: "clean",
        cutoverTime: "2026-07-26T00:00:00.000Z",
        isActive: true,
      },
      paths: {
        authoritativeDbFile: path.join(root, "shift.sqlite"),
        transcriptDir,
        auditTranscriptDir: path.join(root, "audit-transcripts"),
      },
      canonicalCoverage: {
        required: true,
        verified: true,
        sourceCanonicalEvents: 1,
        archivedCanonicalEvents: 1,
        missingFromAudit: [],
      },
    });
    assert.equal(manifest.canonicalCoverage.verified, true);
    assert.equal(manifest.targets.find((item) => item.id === "transcripts").exists, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

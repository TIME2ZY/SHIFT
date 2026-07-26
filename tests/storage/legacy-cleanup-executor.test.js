const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { prepareCleanEpoch } = require("../../src/storage/clean-epoch");
const { createStorage } = require("../../src/storage");
const { buildLegacyCleanupManifest } = require("../../src/storage/legacy-cleanup-manifest");
const { executeLegacyCleanup } = require("../../src/storage/legacy-cleanup-executor");

test("legacy cleanup validates exact fingerprints and deletes only allowlisted targets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shift-cleanup-executor-"));
  const databaseFile = path.join(root, "shift.sqlite");
  const auditRoot = path.join(root, "audit-transcripts");
  prepareCleanEpoch({ file: databaseFile });
  const storage = createStorage({ file: databaseFile });
  const epoch = storage.metadata.getCurrent();
  storage.close();
  fs.mkdirSync(path.join(auditRoot, epoch.epochId), { recursive: true });

  const paths = {
    authoritativeDbFile: databaseFile,
    auditTranscriptDir: auditRoot,
    sessionsFile: path.join(root, "sessions.json"),
    invocationsFile: path.join(root, "invocations.json"),
    transcriptDir: path.join(root, "transcripts"),
    sessionMapRoot: path.join(root, "session-maps"),
    legacyDbFile: path.join(root, "memory.sqlite"),
  };
  fs.writeFileSync(paths.sessionsFile, "{}");
  fs.writeFileSync(paths.invocationsFile, "{}");
  fs.mkdirSync(paths.transcriptDir);
  fs.mkdirSync(paths.sessionMapRoot);
  fs.writeFileSync(paths.legacyDbFile, "legacy");
  fs.writeFileSync(`${paths.legacyDbFile}-wal`, "legacy-wal");
  fs.writeFileSync(`${paths.legacyDbFile}-shm`, "legacy-shm");
  const manifest = buildLegacyCleanupManifest({
    paths,
    epoch,
    canonicalCoverage: {
      required: false,
      verified: true,
      sourceCanonicalEvents: 0,
      archivedCanonicalEvents: 0,
      missingFromAudit: [],
    },
  });
  const manifestFile = path.join(root, "cleanup.json");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));

  try {
    const checked = executeLegacyCleanup({
      manifestFile,
      confirmation: manifest.confirmation,
    });
    assert.equal(checked.action, "validate-only");
    assert.equal(fs.existsSync(paths.sessionsFile), true);

    const deleted = executeLegacyCleanup({
      manifestFile,
      confirmation: manifest.confirmation,
      apply: true,
    });
    assert.deepEqual(deleted.deleted.sort(), Object.keys({
      sessions: 1,
      invocations: 1,
      transcripts: 1,
      "session-maps": 1,
      "legacy-validation-db": 1,
      "legacy-validation-db-wal": 1,
      "legacy-validation-db-shm": 1,
    }).sort());
    assert.equal(fs.existsSync(databaseFile), true);
    assert.equal(fs.existsSync(auditRoot), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy cleanup blocks changed targets and wrong confirmation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shift-cleanup-change-"));
  const databaseFile = path.join(root, "shift.sqlite");
  const auditRoot = path.join(root, "audit-transcripts");
  prepareCleanEpoch({ file: databaseFile });
  const storage = createStorage({ file: databaseFile });
  const epoch = storage.metadata.getCurrent();
  storage.close();
  fs.mkdirSync(path.join(auditRoot, epoch.epochId), { recursive: true });
  const paths = {
    authoritativeDbFile: databaseFile,
    auditTranscriptDir: auditRoot,
    sessionsFile: path.join(root, "sessions.json"),
    invocationsFile: path.join(root, "invocations.json"),
    transcriptDir: path.join(root, "transcripts"),
    sessionMapRoot: path.join(root, "session-maps"),
    legacyDbFile: path.join(root, "memory.sqlite"),
  };
  fs.writeFileSync(paths.sessionsFile, "{}");
  fs.writeFileSync(paths.invocationsFile, "{}");
  fs.mkdirSync(paths.transcriptDir);
  fs.mkdirSync(paths.sessionMapRoot);
  fs.writeFileSync(paths.legacyDbFile, "legacy");
  fs.writeFileSync(`${paths.legacyDbFile}-wal`, "wal");
  fs.writeFileSync(`${paths.legacyDbFile}-shm`, "shm");
  const manifest = buildLegacyCleanupManifest({
    paths,
    epoch,
    canonicalCoverage: {
      required: false,
      verified: true,
      sourceCanonicalEvents: 0,
      archivedCanonicalEvents: 0,
      missingFromAudit: [],
    },
  });
  const manifestFile = path.join(root, "cleanup.json");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  try {
    assert.throws(
      () => executeLegacyCleanup({ manifestFile, confirmation: "wrong" }),
      /Confirmation must exactly match/
    );
    fs.appendFileSync(paths.sessionsFile, "changed");
    assert.throws(
      () =>
        executeLegacyCleanup({
          manifestFile,
          confirmation: manifest.confirmation,
        }),
      /changed since planning/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

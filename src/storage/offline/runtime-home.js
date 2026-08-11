const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { ROOT, pathsOverlap } = require("../../shared/runtime-paths");
const { createStorage } = require("../index");
const { backupDatabase, integrityCheck } = require("../maintenance");
const { normalizeCanonicalPath, resolveProjectIdentity } = require("../project-identity");
const { prepareCleanEpoch } = require("./clean-epoch");
const { compareSnapshots, inspectCausality, snapshot } = require("./recovery-drill");
const { LEGACY_DATABASE_FILE } = require("./legacy-runtime-paths");

const MIGRATION_ID = "runtime-home-v1";
const KNOWN_LEGACY_NAMES = Object.freeze([
  "shift.sqlite",
  "shift.sqlite-wal",
  "shift.sqlite-shm",
  "memory.sqlite",
  "memory.sqlite-wal",
  "memory.sqlite-shm",
  "sessions.json",
  "invocations.json",
  "worktrees.json",
  "audit-transcripts",
  "raw-events",
  "transcripts",
  "session-maps",
]);

function initializeRuntimeHome({ runtimePaths, cutoverTime } = {}) {
  const paths = requireRuntimePaths(runtimePaths);
  fs.mkdirSync(paths.dataDir, { recursive: true });
  const result = prepareCleanEpoch({ file: paths.databaseFile, cutoverTime });
  return {
    ...result,
    shiftHome: paths.shiftHome,
    dataDir: paths.dataDir,
  };
}

async function migrateRuntimeHome(options = {}) {
  const paths = requireRuntimePaths(options.runtimePaths);
  const sourceFile = path.resolve(options.sourceFile || LEGACY_DATABASE_FILE);
  const projectDir = path.resolve(options.projectDir || ROOT);
  const manifestFile = path.join(paths.migrationDir, `${MIGRATION_ID}.json`);

  const already = readCompletedManifest(manifestFile, paths.databaseFile);
  if (already) return { ...already, alreadyMigrated: true, manifestFile };
  assertFreshTarget(paths, manifestFile);
  assertSourceDatabase(sourceFile, paths.databaseFile);
  if (pathsOverlap(path.dirname(sourceFile), paths.dataDir)) {
    throw new Error("Legacy runtime directory must not overlap SHIFT_HOME/data.");
  }
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    throw new Error(`Migration project directory does not exist: ${projectDir}`);
  }

  fs.mkdirSync(paths.migrationDir, { recursive: true });
  fs.mkdirSync(paths.backupDir, { recursive: true });
  const tempFile = path.join(paths.migrationDir, "shift.sqlite.tmp");
  removeSqliteFamily(tempFile);

  const projectIdentity = resolveProjectIdentity(projectDir, options.projectIdentityOptions);
  if (!projectIdentity.projectKey) {
    throw new Error(`Migration project identity could not be resolved: ${projectDir}`);
  }

  let sourceSnapshot;
  let sourceIntegrity;
  let backupResult;
  const sourceStorage = createStorage({ file: sourceFile });
  try {
    assertActiveCleanEpoch(sourceStorage, "Source");
    assertNoActiveInvocations(sourceStorage);
    validateThreadsBelongToProject(
      sourceStorage.db,
      projectIdentity,
      projectDir,
      options.projectIdentityOptions
    );
    sourceIntegrity = integrityCheck(sourceStorage.db, { full: true });
    if (!sourceIntegrity.ok) throw new Error("Source database failed integrity checks.");
    sourceSnapshot = snapshot(sourceStorage);
    backupResult = await backupDatabase(sourceStorage.db, tempFile);
  } finally {
    sourceStorage.close();
  }

  let targetSnapshotBeforeBinding;
  let targetSnapshot;
  let targetIntegrity;
  let causality;
  let binding;
  const targetStorage = createStorage({ file: tempFile });
  try {
    assertActiveCleanEpoch(targetStorage, "Migrated");
    targetSnapshotBeforeBinding = snapshot(targetStorage);
    const backupMismatches = compareSnapshots(sourceSnapshot, targetSnapshotBeforeBinding);
    if (backupMismatches.length > 0) {
      throw new Error(`SQLite backup verification failed: ${JSON.stringify(backupMismatches)}`);
    }
    binding = bindThreadsToProject(targetStorage.db, projectIdentity, projectDir);
    targetIntegrity = integrityCheck(targetStorage.db, { full: true });
    causality = inspectCausality(targetStorage.db);
    if (!targetIntegrity.ok || !causality.ok) {
      throw new Error("Migrated database failed integrity or causality checks.");
    }
    targetStorage.checkpoint("TRUNCATE");
    targetSnapshot = snapshot(targetStorage);
  } finally {
    targetStorage.close();
  }

  const completedAt = resolveNow(options.now).toISOString();
  const backupRoot = path.join(
    paths.backupDir,
    `pre-${MIGRATION_ID}-${completedAt.replace(/[:.]/g, "-")}`
  );
  const legacyRuntimeDir = path.dirname(sourceFile);
  const backup = backupLegacyRuntime({ sourceFile, legacyRuntimeDir, backupRoot });
  const copiedRuntime = copyOnlineRuntimeArtifacts({ legacyRuntimeDir, runtimePaths: paths });

  fs.renameSync(tempFile, paths.databaseFile);
  const manifest = {
    migration: MIGRATION_ID,
    completedAt,
    verified: true,
    source: sourceFile,
    target: paths.databaseFile,
    project: {
      projectKey: projectIdentity.projectKey,
      canonicalPath: projectIdentity.canonicalPath,
      identityKind: projectIdentity.kind,
    },
    sourceIntegrity,
    targetIntegrity,
    causality,
    sourceSnapshot,
    targetSnapshotBeforeBinding,
    targetSnapshot,
    binding,
    sqliteBackupBytes: backupResult.bytes,
    backup,
    copiedRuntime,
  };
  writeJsonAtomic(manifestFile, manifest);

  const cleanup = cleanupBackedUpLegacyRuntime({
    legacyRuntimeDir,
    sourceFile,
    backupRoot,
  });
  const finalManifest = { ...manifest, cleanup };
  writeJsonAtomic(manifestFile, finalManifest);
  return { ...finalManifest, manifestFile, alreadyMigrated: false };
}

function bindThreadsToProject(db, identity, projectDir) {
  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT * FROM projects WHERE project_key = ?")
    .get(identity.projectKey);
  if (
    existing &&
    normalizePath(existing.canonical_path) !== normalizePath(identity.canonicalPath)
  ) {
    throw new Error(`Project identity collision for ${identity.projectKey}.`);
  }
  if (!existing) {
    db.prepare(
      `
      INSERT INTO projects
        (project_key, identity_kind, canonical_path, created_at, updated_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `
    ).run(
      identity.projectKey,
      identity.kind,
      identity.canonicalPath,
      now,
      now,
      JSON.stringify(identity)
    );
  }

  const rows = db.prepare("SELECT id, project_dir, project_key FROM threads ORDER BY id").all();
  const update = db.prepare(`
    UPDATE threads
    SET project_dir = ?,
        project_key = ?,
        project_canonical_path = ?,
        project_identity_kind = ?,
        project_identity_json = ?
    WHERE id = ?
  `);
  let changed = 0;
  db.transaction(() => {
    for (const row of rows) {
      const needsUpdate =
        !String(row.project_dir || "").trim() || row.project_key !== identity.projectKey;
      if (!needsUpdate) continue;
      update.run(
        projectDir,
        identity.projectKey,
        identity.canonicalPath,
        identity.kind,
        JSON.stringify(identity),
        row.id
      );
      changed += 1;
    }
  })();
  return { threads: rows.length, changed, projectCreated: !existing };
}

function validateThreadsBelongToProject(db, expectedIdentity, projectDir, identityOptions) {
  const rows = db.prepare("SELECT id, project_dir, project_key FROM threads ORDER BY id").all();
  const mismatches = [];
  for (const row of rows) {
    const configuredDir = String(row.project_dir || "").trim();
    if (!configuredDir && !row.project_key) continue;
    let actualIdentity = null;
    if (configuredDir) actualIdentity = resolveProjectIdentity(configuredDir, identityOptions);
    const actualKey = actualIdentity?.projectKey || row.project_key || null;
    if (actualKey !== expectedIdentity.projectKey) {
      mismatches.push({
        threadId: row.id,
        projectDir: configuredDir || null,
        projectKey: row.project_key || null,
        resolvedProjectKey: actualIdentity?.projectKey || null,
      });
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Existing data is not exclusively owned by the SHIFT project ${projectDir}: ` +
        JSON.stringify(mismatches.slice(0, 10))
    );
  }
  return { threads: rows.length };
}

function backupLegacyRuntime({ sourceFile, legacyRuntimeDir, backupRoot }) {
  fs.mkdirSync(backupRoot, { recursive: true });
  const copied = [];
  const sourceFamily = [sourceFile, `${sourceFile}-wal`, `${sourceFile}-shm`];
  for (const item of sourceFamily) {
    if (!fs.existsSync(item)) continue;
    const destination = path.join(backupRoot, "database", path.basename(item));
    copyPath(item, destination);
    copied.push(relativeReportPath(backupRoot, destination));
  }
  for (const name of KNOWN_LEGACY_NAMES) {
    const item = path.join(legacyRuntimeDir, name);
    if (!fs.existsSync(item) || sourceFamily.includes(item)) continue;
    const destination = path.join(backupRoot, "runtime", name);
    copyPath(item, destination);
    copied.push(relativeReportPath(backupRoot, destination));
  }
  return {
    root: backupRoot,
    copied,
    fingerprint: fingerprintTree(backupRoot),
  };
}

function copyOnlineRuntimeArtifacts({ legacyRuntimeDir, runtimePaths }) {
  const mappings = [
    ["audit-transcripts", runtimePaths.auditTranscriptDir],
    ["raw-events", runtimePaths.rawEventsDir],
    ["worktrees.json", runtimePaths.worktreeStateFile],
  ];
  const copied = [];
  for (const [name, destination] of mappings) {
    const source = path.join(legacyRuntimeDir, name);
    if (!fs.existsSync(source)) continue;
    copyPath(source, destination);
    copied.push({ source, destination });
  }
  return copied;
}

function cleanupBackedUpLegacyRuntime({ legacyRuntimeDir, sourceFile, backupRoot }) {
  const removed = [];
  const retained = [];
  const candidates = new Set([
    sourceFile,
    `${sourceFile}-wal`,
    `${sourceFile}-shm`,
    ...KNOWN_LEGACY_NAMES.map((name) => path.join(legacyRuntimeDir, name)),
  ]);
  for (const item of candidates) {
    if (!fs.existsSync(item)) continue;
    assertInside(legacyRuntimeDir, item);
    const backupCandidate = [
      path.join(backupRoot, "database", path.basename(item)),
      path.join(backupRoot, "runtime", path.basename(item)),
    ].find((candidate) => fs.existsSync(candidate));
    if (!backupCandidate) {
      retained.push(item);
      continue;
    }
    fs.rmSync(item, { recursive: true, force: false });
    removed.push(item);
  }
  if (fs.existsSync(legacyRuntimeDir)) {
    for (const name of fs.readdirSync(legacyRuntimeDir))
      retained.push(path.join(legacyRuntimeDir, name));
  }
  return { removed, retained: [...new Set(retained)].sort() };
}

function assertFreshTarget(paths, manifestFile) {
  const targetFamily = [
    paths.databaseFile,
    `${paths.databaseFile}-wal`,
    `${paths.databaseFile}-shm`,
  ];
  const existing = targetFamily.filter((item) => fs.existsSync(item));
  if (existing.length > 0) {
    throw new Error(
      `Runtime-home target already exists without a verified migration manifest: ${existing.join(", ")}`
    );
  }
  if (fs.existsSync(manifestFile)) {
    throw new Error(`Migration manifest exists without a usable target database: ${manifestFile}`);
  }
}

function assertSourceDatabase(sourceFile, targetFile) {
  if (sourceFile === path.resolve(targetFile)) {
    throw new Error("Migration source and target must be different files.");
  }
  if (!fs.existsSync(sourceFile) || !fs.statSync(sourceFile).isFile()) {
    throw new Error(`Source SQLite database does not exist: ${sourceFile}`);
  }
}

function assertActiveCleanEpoch(storage, label) {
  const epoch = storage.metadata.getCurrent();
  if (!epoch.isClean || !epoch.isActive) {
    throw new Error(`${label} database is not an active clean epoch.`);
  }
}

function assertNoActiveInvocations(storage) {
  const count = Number(
    storage.db.prepare("SELECT COUNT(*) AS count FROM invocations WHERE state = 'active'").get()
      .count || 0
  );
  if (count > 0) {
    throw new Error(`Runtime-home migration requires zero active invocations; found ${count}.`);
  }
}

function readCompletedManifest(manifestFile, targetFile) {
  if (!fs.existsSync(manifestFile) || !fs.existsSync(targetFile)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    if (
      parsed?.migration === MIGRATION_ID &&
      parsed?.verified === true &&
      path.resolve(parsed.target) === path.resolve(targetFile)
    ) {
      return parsed;
    }
  } catch {}
  return null;
}

function requireRuntimePaths(value) {
  const required = [
    "shiftHome",
    "dataDir",
    "databaseFile",
    "auditTranscriptDir",
    "rawEventsDir",
    "worktreeStateFile",
    "migrationDir",
    "backupDir",
  ];
  if (!value || required.some((key) => typeof value[key] !== "string" || !value[key])) {
    throw new Error("Resolved SHIFT runtime paths are required.");
  }
  return value;
}

function copyPath(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.statSync(source).isDirectory()) {
    fs.cpSync(source, destination, { recursive: true, force: true });
  } else {
    fs.copyFileSync(source, destination);
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}

function removeSqliteFamily(file) {
  for (const item of [file, `${file}-wal`, `${file}-shm`]) {
    if (fs.existsSync(item)) fs.rmSync(item, { force: true });
  }
}

function fingerprintTree(root) {
  const hash = crypto.createHash("sha256");
  for (const file of listFiles(root)) {
    hash.update(relativeReportPath(root, file));
    hash.update(fs.readFileSync(file));
  }
  return hash.digest("hex");
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const visit = (current) => {
    const stat = fs.statSync(current);
    if (stat.isFile()) {
      out.push(current);
      return;
    }
    for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name));
  };
  visit(root);
  return out.sort();
}

function assertInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Legacy cleanup target escapes runtime directory: ${target}`);
  }
}

function relativeReportPath(root, target) {
  return path.relative(root, target).replace(/\\/g, "/");
}

function normalizePath(value) {
  return normalizeCanonicalPath(value);
}

function resolveNow(value) {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) throw new Error("Migration timestamp is invalid.");
  return date;
}

module.exports = {
  MIGRATION_ID,
  KNOWN_LEGACY_NAMES,
  initializeRuntimeHome,
  migrateRuntimeHome,
  validateThreadsBelongToProject,
  bindThreadsToProject,
};

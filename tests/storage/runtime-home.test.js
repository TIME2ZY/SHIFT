const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createRuntimePaths } = require("../../src/shared/runtime-paths");
const { createStorage } = require("../../src/storage");
const {
  initializeRuntimeHome,
  migrateRuntimeHome,
} = require("../../src/storage/offline/runtime-home");

const PROJECT_IDENTITY_OPTIONS = Object.freeze({ skipGit: true });

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-home-migration-"));
  const projectDir = path.join(root, "project");
  const legacyRuntimeDir = path.join(root, "legacy", "data", "runtime");
  const shiftHome = path.join(root, "user", ".shift");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(legacyRuntimeDir, { recursive: true });
  return {
    root,
    projectDir,
    legacyRuntimeDir,
    sourceFile: path.join(legacyRuntimeDir, "shift.sqlite"),
    runtimePaths: createRuntimePaths({ env: { SHIFT_HOME: shiftHome } }),
  };
}

function createActiveSource(fixture, threadProjectDir = fixture.projectDir) {
  const storage = createStorage({ file: fixture.sourceFile });
  storage.metadata.activateCleanCutover({ cutoverTime: "2026-08-09T00:00:00.000Z" });
  storage.threads.create({
    id: "thread-1",
    title: "Migrated thread",
    projectDir: threadProjectDir,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
  });
  storage.messages.append({
    id: "message-1",
    threadId: "thread-1",
    sequenceNo: 0,
    role: "user",
    content: "preserve me",
    createdAt: "2026-08-09T00:00:01.000Z",
  });
  storage.close();
}

function removeFixture(fixture) {
  fs.rmSync(fixture.root, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 50,
  });
}

test("runtime home initialization creates the only database under SHIFT_HOME/data", () => {
  const fixture = createFixture();
  try {
    const result = initializeRuntimeHome({
      runtimePaths: fixture.runtimePaths,
      cutoverTime: "2026-08-09T00:00:00.000Z",
    });
    assert.equal(result.file, fixture.runtimePaths.databaseFile);
    assert.equal(result.epoch.isActive, true);
    assert.equal(fs.existsSync(fixture.runtimePaths.databaseFile), true);
    assert.throws(
      () => initializeRuntimeHome({ runtimePaths: fixture.runtimePaths }),
      /must not already exist/
    );
  } finally {
    removeFixture(fixture);
  }
});

test("one-time migration preserves SQLite data and moves known runtime artifacts", async () => {
  const fixture = createFixture();
  try {
    createActiveSource(fixture);
    fs.mkdirSync(path.join(fixture.legacyRuntimeDir, "audit-transcripts", "epoch"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(fixture.legacyRuntimeDir, "audit-transcripts", "epoch", "events.jsonl"),
      "{}\n"
    );
    fs.mkdirSync(path.join(fixture.legacyRuntimeDir, "raw-events"), { recursive: true });
    fs.writeFileSync(path.join(fixture.legacyRuntimeDir, "raw-events", "inv.jsonl"), "{}\n");
    fs.writeFileSync(path.join(fixture.legacyRuntimeDir, "worktrees.json"), '{"worktrees":{}}\n');
    fs.writeFileSync(path.join(fixture.legacyRuntimeDir, "unknown.keep"), "keep\n");

    const report = await migrateRuntimeHome({
      runtimePaths: fixture.runtimePaths,
      sourceFile: fixture.sourceFile,
      projectDir: fixture.projectDir,
      projectIdentityOptions: PROJECT_IDENTITY_OPTIONS,
      now: "2026-08-09T12:00:00.000Z",
    });

    assert.equal(report.alreadyMigrated, false);
    assert.equal(report.verified, true);
    assert.equal(report.binding.threads, 1);
    assert.equal(fs.existsSync(fixture.runtimePaths.databaseFile), true);
    assert.equal(fs.existsSync(fixture.sourceFile), false);
    assert.equal(
      fs.existsSync(path.join(fixture.runtimePaths.auditTranscriptDir, "epoch", "events.jsonl")),
      true
    );
    assert.equal(fs.existsSync(path.join(fixture.runtimePaths.rawEventsDir, "inv.jsonl")), true);
    assert.equal(fs.existsSync(fixture.runtimePaths.worktreeStateFile), true);
    assert.equal(fs.existsSync(path.join(fixture.legacyRuntimeDir, "unknown.keep")), true);

    const migrated = createStorage({ file: fixture.runtimePaths.databaseFile });
    try {
      assert.equal(migrated.threads.get("thread-1").projectKey, report.project.projectKey);
      assert.equal(migrated.messages.listForThread("thread-1")[0].content, "preserve me");
    } finally {
      migrated.close();
    }

    const repeated = await migrateRuntimeHome({
      runtimePaths: fixture.runtimePaths,
      sourceFile: fixture.sourceFile,
      projectDir: fixture.projectDir,
      projectIdentityOptions: PROJECT_IDENTITY_OPTIONS,
    });
    assert.equal(repeated.alreadyMigrated, true);
    assert.equal(repeated.target, fixture.runtimePaths.databaseFile);
  } finally {
    removeFixture(fixture);
  }
});

test("migration rejects data owned by a different project without publishing a target", async () => {
  const fixture = createFixture();
  const otherProject = path.join(fixture.root, "other-project");
  fs.mkdirSync(otherProject, { recursive: true });
  try {
    createActiveSource(fixture, otherProject);
    await assert.rejects(
      () =>
        migrateRuntimeHome({
          runtimePaths: fixture.runtimePaths,
          sourceFile: fixture.sourceFile,
          projectDir: fixture.projectDir,
          projectIdentityOptions: PROJECT_IDENTITY_OPTIONS,
        }),
      /not exclusively owned by the SHIFT project/
    );
    assert.equal(fs.existsSync(fixture.sourceFile), true);
    assert.equal(fs.existsSync(fixture.runtimePaths.databaseFile), false);
  } finally {
    removeFixture(fixture);
  }
});

test("migration refuses to cut over while an invocation is active", async () => {
  const fixture = createFixture();
  try {
    createActiveSource(fixture);
    const storage = createStorage({ file: fixture.sourceFile });
    try {
      storage.windows.create({
        id: "window-1",
        threadId: "thread-1",
        agentId: "codex",
        providerKey: "codex",
        workspaceKey: "base",
        generation: 1,
        capacityTokens: 1000,
        reserveRatio: 0.2,
      });
      storage.invocations.start({
        id: "invocation-active",
        threadId: "thread-1",
        windowId: "window-1",
        agentId: "codex",
        startedAt: "2026-08-09T00:00:02.000Z",
      });
    } finally {
      storage.close();
    }

    await assert.rejects(
      () =>
        migrateRuntimeHome({
          runtimePaths: fixture.runtimePaths,
          sourceFile: fixture.sourceFile,
          projectDir: fixture.projectDir,
          projectIdentityOptions: PROJECT_IDENTITY_OPTIONS,
        }),
      /requires zero active invocations/
    );
    assert.equal(fs.existsSync(fixture.sourceFile), true);
    assert.equal(fs.existsSync(fixture.runtimePaths.databaseFile), false);
  } finally {
    removeFixture(fixture);
  }
});

test("migration fails closed when target and manifest state disagree", async () => {
  const fixture = createFixture();
  try {
    createActiveSource(fixture);
    fs.mkdirSync(fixture.runtimePaths.dataDir, { recursive: true });
    fs.copyFileSync(fixture.sourceFile, fixture.runtimePaths.databaseFile);

    await assert.rejects(
      () =>
        migrateRuntimeHome({
          runtimePaths: fixture.runtimePaths,
          sourceFile: fixture.sourceFile,
          projectDir: fixture.projectDir,
          projectIdentityOptions: PROJECT_IDENTITY_OPTIONS,
        }),
      /target already exists without a verified migration manifest/
    );
    assert.equal(fs.existsSync(fixture.sourceFile), true);
  } finally {
    removeFixture(fixture);
  }
});

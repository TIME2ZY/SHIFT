const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const { resolveProjectIdentity } = require("../../src/storage/project-identity");

function createFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-repository-"));
  const projectDir = path.join(root, "plain-project");
  fs.mkdirSync(projectDir, { recursive: true });
  const storage = createStorage({
    file: path.join(root, "shift.sqlite"),
    projectRepositoryOptions: {
      identityResolver:
        options.identityResolver ||
        ((directory) => resolveProjectIdentity(directory, { skipGit: true })),
    },
  });
  return { root, projectDir, storage };
}

function closeFixture(fixture) {
  fixture.storage.close();
  fs.rmSync(fixture.root, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 50,
  });
}

test("project lifecycle migration adds authoritative project fields", () => {
  const fixture = createFixture();
  try {
    const columns = new Set(
      fixture.storage.db
        .prepare("PRAGMA table_info(projects)")
        .all()
        .map((column) => column.name)
    );
    assert.equal(columns.has("display_name"), true);
    assert.equal(columns.has("last_opened_at"), true);
    assert.equal(columns.has("archived_at"), true);
  } finally {
    closeFixture(fixture);
  }
});

test("opening a non-Git directory creates one active Project without initializing Git", () => {
  const fixture = createFixture();
  try {
    const first = fixture.storage.projects.openDirectory(fixture.projectDir, {
      at: "2026-08-10T00:00:00.000Z",
    });
    const second = fixture.storage.projects.openDirectory(fixture.projectDir, {
      at: "2026-08-10T01:00:00.000Z",
    });

    assert.equal(first.projectKey, second.projectKey);
    assert.equal(second.identityKind, "directory");
    assert.equal(second.displayName, "plain-project");
    assert.equal(second.lastOpenedAt, "2026-08-10T01:00:00.000Z");
    assert.equal(second.archivedAt, null);
    assert.equal(fixture.storage.projects.list().length, 1);
    assert.equal(fs.existsSync(path.join(fixture.projectDir, ".git")), false);
  } finally {
    closeFixture(fixture);
  }
});

test("opening the same canonical directory preserves its original Project key", () => {
  let identityKind = "directory";
  const fixture = createFixture({
    identityResolver(directory) {
      const canonicalPath = directory.replace(/\\/g, "/");
      return {
        kind: identityKind,
        projectKey: `${identityKind}:${identityKind === "directory" ? "first" : "second"}`,
        canonicalPath,
        resolution: "test",
      };
    },
  });
  try {
    const first = fixture.storage.projects.openDirectory(fixture.projectDir);
    identityKind = "git-worktree";
    const reopened = fixture.storage.projects.openDirectory(fixture.projectDir);

    assert.equal(reopened.projectKey, first.projectKey);
    assert.equal(reopened.identityKind, "git-worktree");
    assert.equal(fixture.storage.projects.list().length, 1);
  } finally {
    closeFixture(fixture);
  }
});

test("archiving hides a Project without deleting its Threads and restore recovers it", () => {
  const fixture = createFixture();
  try {
    const project = fixture.storage.projects.openDirectory(fixture.projectDir);
    fixture.storage.threads.create({
      id: "thread-1",
      title: "preserved",
      projectDir: fixture.projectDir,
    });

    const archived = fixture.storage.projects.archive(project.projectKey, {
      at: "2026-08-10T02:00:00.000Z",
    });
    assert.equal(archived.archivedAt, "2026-08-10T02:00:00.000Z");
    assert.equal(fixture.storage.projects.get(project.projectKey), null);
    assert.equal(fixture.storage.projects.list().length, 0);
    assert.equal(fixture.storage.projects.list({ archived: true })[0].threadCount, 1);
    assert.equal(fixture.storage.threads.get("thread-1").title, "preserved");

    const restored = fixture.storage.projects.restore(project.projectKey, {
      at: "2026-08-10T03:00:00.000Z",
    });
    assert.equal(restored.archivedAt, null);
    assert.equal(restored.lastOpenedAt, "2026-08-10T03:00:00.000Z");
    assert.equal(fixture.storage.projects.list()[0].threadCount, 1);
  } finally {
    closeFixture(fixture);
  }
});

test("opening an archived directory restores the original Project", () => {
  const fixture = createFixture();
  try {
    const project = fixture.storage.projects.openDirectory(fixture.projectDir);
    fixture.storage.projects.archive(project.projectKey, {
      at: "2026-08-10T02:00:00.000Z",
    });

    const reopened = fixture.storage.projects.openDirectory(fixture.projectDir, {
      at: "2026-08-10T04:00:00.000Z",
    });
    assert.equal(reopened.projectKey, project.projectKey);
    assert.equal(reopened.archivedAt, null);
    assert.equal(reopened.lastOpenedAt, "2026-08-10T04:00:00.000Z");
    assert.equal(fixture.storage.projects.list({ archived: true }).length, 0);
  } finally {
    closeFixture(fixture);
  }
});

test("archiving fails while the Project owns an active Invocation", () => {
  const fixture = createFixture();
  try {
    const project = fixture.storage.projects.openDirectory(fixture.projectDir);
    fixture.storage.threads.create({
      id: "thread-1",
      title: "active",
      projectDir: fixture.projectDir,
    });
    fixture.storage.windows.create({
      id: "window-1",
      threadId: "thread-1",
      agentId: "codex",
      providerKey: "codex",
      workspaceKey: "base",
      generation: 1,
      capacityTokens: 1000,
      reserveRatio: 0.2,
    });
    fixture.storage.invocations.start({
      id: "invocation-1",
      threadId: "thread-1",
      windowId: "window-1",
      agentId: "codex",
    });

    assert.throws(
      () => fixture.storage.projects.archive(project.projectKey),
      (error) =>
        error.code === "PROJECT_ACTIVE_INVOCATIONS" &&
        error.statusCode === 409 &&
        error.activeInvocationCount === 1
    );
    assert.ok(fixture.storage.projects.get(project.projectKey));

    fixture.storage.invocations.finish("invocation-1", { state: "completed" });
    assert.ok(fixture.storage.projects.archive(project.projectKey).archivedAt);
  } finally {
    closeFixture(fixture);
  }
});

test("opening rejects missing paths and regular files", () => {
  const fixture = createFixture();
  const file = path.join(fixture.root, "not-a-project.txt");
  fs.writeFileSync(file, "file\n");
  try {
    for (const candidate of [path.join(fixture.root, "missing"), file]) {
      assert.throws(
        () => fixture.storage.projects.openDirectory(candidate),
        (error) => error.code === "PROJECT_DIRECTORY_INVALID" && error.statusCode === 400
      );
    }
    assert.equal(fixture.storage.projects.list().length, 0);
  } finally {
    closeFixture(fixture);
  }
});

test("requireActive distinguishes archived and unknown Projects", () => {
  const fixture = createFixture();
  try {
    const project = fixture.storage.projects.openDirectory(fixture.projectDir);
    assert.equal(
      fixture.storage.projects.requireActive(project.projectKey).projectKey,
      project.projectKey
    );
    fixture.storage.projects.archive(project.projectKey);
    assert.throws(
      () => fixture.storage.projects.requireActive(project.projectKey),
      (error) => error.code === "PROJECT_ARCHIVED" && error.statusCode === 409
    );
    assert.throws(
      () => fixture.storage.projects.requireActive("dir:missing"),
      (error) => error.code === "PROJECT_NOT_FOUND" && error.statusCode === 404
    );
  } finally {
    closeFixture(fixture);
  }
});

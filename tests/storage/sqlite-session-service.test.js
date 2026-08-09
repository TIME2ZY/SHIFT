const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const { createSqliteSessionService } = require("../../src/storage/sqlite-session-service");

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-project-sessions-"));
  const projectDir = path.join(root, "project-a");
  const otherDir = path.join(root, "project-b");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(otherDir, { recursive: true });
  const storage = createStorage({ file: ":memory:" });
  const project = storage.projects.openDirectory(projectDir);
  const otherProject = storage.projects.openDirectory(otherDir);
  const sessions = createSqliteSessionService({ storage });
  return { root, storage, sessions, project, otherProject };
}

function closeFixture(fixture) {
  fixture.sessions.close();
  fixture.storage.close();
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

test("sqlite session service creates immutable Project-bound Sessions", () => {
  const fixture = createFixture();
  try {
    const created = fixture.sessions.createSession({
      projectKey: fixture.project.projectKey,
    });
    assert.ok(created.id);
    assert.equal(created.projectKey, fixture.project.projectKey);
    assert.equal(created.projectDir, fixture.project.canonicalPath);
    assert.equal(created.messages.length, 0);
    assert.equal("setSessionProjectDir" in fixture.sessions, false);

    assert.throws(
      () => fixture.sessions.createSession(),
      (error) => error.code === "PROJECT_KEY_REQUIRED" && error.statusCode === 400
    );
  } finally {
    closeFixture(fixture);
  }
});

test("sqlite session listing is isolated to one active Project", () => {
  const fixture = createFixture();
  try {
    const first = fixture.sessions.createSession({ projectKey: fixture.project.projectKey });
    const second = fixture.sessions.createSession({
      projectKey: fixture.otherProject.projectKey,
    });
    assert.deepEqual(
      fixture.sessions.listSessions(fixture.project.projectKey).map((session) => session.id),
      [first.id]
    );
    assert.deepEqual(
      fixture.sessions.listSessions(fixture.otherProject.projectKey).map((session) => session.id),
      [second.id]
    );
  } finally {
    closeFixture(fixture);
  }
});

test("sqlite session service appends messages without changing Project ownership", () => {
  const fixture = createFixture();
  try {
    const created = fixture.sessions.createSession({ projectKey: fixture.project.projectKey });
    const afterUser = fixture.sessions.appendToSession(created.id, {
      role: "user",
      agent: "codex",
      content: "@Grok   帮我修复登录页面的移动端布局问题",
      clientTurnId: "turn-1",
    });
    const afterAssistant = fixture.sessions.appendToSession(created.id, {
      role: "assistant",
      agent: "gemini",
      content: "ok",
    });

    assert.equal(afterUser.title, "修复登录页面的移动端布局问题");
    assert.equal(afterAssistant.projectKey, fixture.project.projectKey);
    assert.equal(afterAssistant.lastAgent, "codex");
    assert.deepEqual(
      fixture.sessions.listSessions(fixture.project.projectKey)[0].participantAgentIds,
      ["codex", "gemini"]
    );
    assert.equal(
      fixture.sessions.findUserMessageByClientTurnId(created.id, "turn-1").content,
      "@Grok   帮我修复登录页面的移动端布局问题"
    );
  } finally {
    closeFixture(fixture);
  }
});

test("missing Sessions are never created implicitly while appending", () => {
  const fixture = createFixture();
  try {
    assert.equal(
      fixture.sessions.appendToSession("missing-session", {
        role: "user",
        content: "x",
      }),
      null
    );
    assert.equal(fixture.storage.threads.get("missing-session"), null);
  } finally {
    closeFixture(fixture);
  }
});

test("archived Projects hide their Sessions until restored", () => {
  const fixture = createFixture();
  try {
    const created = fixture.sessions.createSession({ projectKey: fixture.project.projectKey });
    fixture.storage.projects.archive(fixture.project.projectKey);

    assert.equal(fixture.sessions.getSession(created.id), null);
    assert.throws(
      () => fixture.sessions.listSessions(fixture.project.projectKey),
      (error) => error.code === "PROJECT_ARCHIVED"
    );
    assert.equal(
      fixture.sessions.appendToSession(created.id, { role: "user", content: "blocked" }),
      null
    );
    assert.equal(fixture.storage.messages.listForThread(created.id).length, 0);

    fixture.storage.projects.restore(fixture.project.projectKey);
    assert.equal(fixture.sessions.getSession(created.id).id, created.id);
  } finally {
    closeFixture(fixture);
  }
});

test("worktree runtime links remain process-local to their bound Session", () => {
  const fixture = createFixture();
  try {
    const created = fixture.sessions.createSession({ projectKey: fixture.project.projectKey });
    fixture.sessions.setSessionWorktree(created.id, { branch: "codex/session-work" });
    assert.deepEqual(fixture.sessions.getSession(created.id).worktree, {
      branch: "codex/session-work",
    });
    assert.equal(fixture.sessions.releaseSession(created.id), true);
    assert.equal(fixture.sessions.getSession(created.id).worktree, null);
  } finally {
    closeFixture(fixture);
  }
});

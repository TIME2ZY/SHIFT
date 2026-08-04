const assert = require("node:assert/strict");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const { createSqliteSessionService } = require("../../src/storage/sqlite-session-service");

test("sqlite session service covers create list append update delete", () => {
  const storage = createStorage({ file: ":memory:" });
  const sessions = createSqliteSessionService({ storage });

  try {
    const created = sessions.createSession();
    assert.ok(created.id);
    assert.equal(created.messages.length, 0);
    assert.equal(sessions.listSessions()[0].title, "");

    const afterUser = sessions.appendToSession(created.id, {
      role: "user",
      agent: "codex",
      content: "Remember the path",
    });
    assert.equal(afterUser.messages.length, 1);
    assert.equal(afterUser.lastAgent, "codex");
    assert.equal(afterUser.title, "Remember the path");
    assert.equal(afterUser.messages[0].messageType, "user");

    const afterAssistant = sessions.appendToSession(
      created.id,
      {
        role: "assistant",
        agent: "gemini",
        content: "ok",
        invocationId: null,
      },
      { allowCreate: false }
    );
    assert.equal(afterAssistant.messages.length, 2);
    // Assistant responses must not rewrite the user-chosen entry agent.
    assert.equal(afterAssistant.lastAgent, "codex");

    sessions.setSessionProjectDir(created.id, "C:/repo");
    sessions.setSessionWorktree(created.id, { branch: "shift/work" });
    const loaded = sessions.getSession(created.id);
    assert.equal(loaded.projectDir, "C:/repo");
    assert.deepEqual(loaded.worktree, { branch: "shift/work" });

    const listed = sessions.listSessions();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].messageCount, 2);
    assert.deepEqual(listed[0].participantAgentIds, ["codex", "gemini"]);

    assert.equal(storage.recall.search(created.id, "Remember the path").length, 1);

    assert.equal(sessions.releaseSession(created.id), true);
    assert.equal(sessions.getSession(created.id).worktree, null);
    assert.equal(storage.threads.delete(created.id), true);
    assert.equal(sessions.getSession(created.id), null);
    assert.equal(storage.threads.list().length, 0);
  } finally {
    sessions.close();
    storage.close();
  }
});

test("sqlite session service refuses append when allowCreate is false", () => {
  const storage = createStorage({ file: ":memory:" });
  const sessions = createSqliteSessionService({ storage });
  try {
    const result = sessions.appendToSession(
      "missing-session",
      { role: "user", content: "x" },
      { allowCreate: false }
    );
    assert.equal(result, null);
  } finally {
    sessions.close();
    storage.close();
  }
});

test("sqlite session service builds a compact title from the first user message", () => {
  const storage = createStorage({ file: ":memory:" });
  const sessions = createSqliteSessionService({ storage });
  try {
    const created = sessions.createSession();
    const afterUser = sessions.appendToSession(created.id, {
      role: "user",
      content: "@Grok   帮我修复登录页面的移动端布局问题",
    });

    assert.equal(afterUser.title, "修复登录页面的移动端布局问题");

    const afterFollowUp = sessions.appendToSession(created.id, {
      role: "user",
      content: "请把标题改成另一件事",
    });
    assert.equal(afterFollowUp.title, afterUser.title);
  } finally {
    sessions.close();
    storage.close();
  }
});

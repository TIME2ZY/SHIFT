const assert = require("node:assert/strict");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const { createSqliteSessionService } = require("../../src/storage/sqlite-session-service");

test("sqlite session service covers create list append update delete", () => {
  const storage = createStorage({ file: ":memory:" });
  const sessions = createSqliteSessionService({ storage });

  try {
    const created = sessions.createSession("sessions.json");
    assert.ok(created.id);
    assert.equal(created.messages.length, 0);

    const afterUser = sessions.appendToSession("sessions.json", created.id, {
      role: "user",
      agent: "codex",
      content: "Remember the path",
    });
    assert.equal(afterUser.messages.length, 1);
    assert.equal(afterUser.lastAgent, "codex");
    assert.equal(afterUser.title, "Remember the path");
    assert.equal(afterUser.messages[0].messageType, "user");

    const afterAssistant = sessions.appendToSession(
      "sessions.json",
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

    sessions.setSessionProjectDir("sessions.json", created.id, "C:/repo");
    sessions.setSessionWorktree("sessions.json", created.id, { branch: "shift/work" });
    const loaded = sessions.getSession("sessions.json", created.id);
    assert.equal(loaded.projectDir, "C:/repo");
    assert.deepEqual(loaded.worktree, { branch: "shift/work" });

    const listed = sessions.listSessions("sessions.json");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].messageCount, 2);

    assert.equal(storage.recall.search(created.id, "Remember the path").length, 1);

    assert.equal(sessions.deleteSession("sessions.json", created.id), true);
    assert.equal(sessions.getSession("sessions.json", created.id), null);
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
      "sessions.json",
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
    const created = sessions.createSession("sessions.json");
    const afterUser = sessions.appendToSession("sessions.json", created.id, {
      role: "user",
      content: "@Grok   帮我修复登录页面的移动端布局问题",
    });

    assert.equal(afterUser.title, "修复登录页面的移动端布局问题");

    const afterFollowUp = sessions.appendToSession("sessions.json", created.id, {
      role: "user",
      content: "请把标题改成另一件事",
    });
    assert.equal(afterFollowUp.title, afterUser.title);
  } finally {
    sessions.close();
    storage.close();
  }
});

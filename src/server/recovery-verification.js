const fs = require("node:fs");
const path = require("node:path");
const { createStorage } = require("../storage");
const { createServer } = require("./index");

async function verifyRestoredSqliteApi({ restoredFile, drillDir }) {
  const expected = selectExpected(restoredFile);
  const runtimeDir = path.join(drillDir, "server-smoke");
  fs.mkdirSync(runtimeDir);
  const token = `recovery-${Date.now()}`;
  const server = createServer({
    storageMode: "sqlite",
    memoryDbFile: restoredFile,
    sessionsFile: path.join(runtimeDir, "must-not-be-created-sessions.json"),
    invocationsFile: path.join(runtimeDir, "must-not-be-created-invocations.json"),
    sessionMapRoot: path.join(runtimeDir, "must-not-be-created-session-maps"),
    auditTranscript: false,
    auditTranscriptDir: path.join(runtimeDir, "must-not-be-created-audit"),
    uiToken: token,
    logger: { log() {}, error() {}, warn() {} },
    worktreeManager: inertWorktreeManager(),
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks = {};
  try {
    const health = await getJson(`${baseUrl}/api/storage/health`, token);
    checks.health = {
      ok:
        health.status === 200 &&
        health.body.storage?.mode === "sqlite" &&
        health.body.storage?.epoch?.epochId === expected.epochId,
      status: health.status,
      mode: health.body.storage?.mode || null,
      epochId: health.body.storage?.epoch?.epochId || null,
    };

    const projects = await getJson(`${baseUrl}/api/projects`, token);
    const sessionResponses = [];
    for (const project of projects.body.projects || []) {
      sessionResponses.push(
        await getJson(
          `${baseUrl}/api/projects/${encodeURIComponent(project.projectKey)}/sessions`,
          token
        )
      );
    }
    const sessions = sessionResponses.flatMap((response) => response.body.sessions || []);
    checks.projects = {
      ok: projects.status === 200 && projects.body.projects?.length === expected.projectCount,
      status: projects.status,
      expected: expected.projectCount,
      actual: projects.body.projects?.length ?? null,
    };
    checks.sessions = {
      ok:
        sessionResponses.every((response) => response.status === 200) &&
        sessions.length === expected.threadCount,
      status: sessionResponses.map((response) => response.status),
      expected: expected.threadCount,
      actual: sessions.length,
    };

    if (expected.threadId) {
      const encoded = encodeURIComponent(expected.threadId);
      const messages = await getJson(`${baseUrl}/api/messages?sessionId=${encoded}`, token);
      checks.messages = {
        ok:
          messages.status === 200 && messages.body.messages?.length === expected.threadMessageCount,
        status: messages.status,
        threadId: expected.threadId,
        expected: expected.threadMessageCount,
        actual: messages.body.messages?.length ?? null,
      };
      const memories = await getJson(`${baseUrl}/api/memories?sessionId=${encoded}`, token);
      checks.context = {
        ok: memories.status === 200 && memories.body.memories?.length === expected.memoryCount,
        status: memories.status,
        threadId: expected.threadId,
        expected: expected.memoryCount,
        actual: memories.body.memories?.length ?? null,
      };
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const legacyArtifacts = [
    "must-not-be-created-sessions.json",
    "must-not-be-created-invocations.json",
    "must-not-be-created-session-maps",
  ].filter((name) => fs.existsSync(path.join(runtimeDir, name)));
  checks.sqliteOnly = { ok: legacyArtifacts.length === 0, legacyArtifacts };
  return {
    ok: Object.values(checks).every((check) => check.ok),
    listenPort: port,
    checks,
  };
}

function selectExpected(file) {
  const storage = createStorage({ file });
  try {
    const projectCount = Number(
      storage.db.prepare("SELECT COUNT(*) AS count FROM projects WHERE archived_at IS NULL").get()
        .count
    );
    const threadCount = Number(
      storage.db
        .prepare(
          `
          SELECT COUNT(*) AS count
          FROM threads t
          JOIN projects p ON p.project_key = t.project_key
          WHERE p.archived_at IS NULL AND t.deleted_at IS NULL
        `
        )
        .get().count
    );
    const thread = storage.db
      .prepare(
        `
        SELECT t.id,
               (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count,
               (SELECT COUNT(*) FROM memory_entries memory
                WHERE memory.owner_thread_id = t.id OR memory.origin_thread_id = t.id) AS memory_count
        FROM threads t
        JOIN projects p ON p.project_key = t.project_key AND p.archived_at IS NULL
        ORDER BY memory_count DESC, message_count DESC, t.created_at DESC, t.id
        LIMIT 1
      `
      )
      .get();
    if (!thread) {
      return {
        epochId: storage.metadata.getCurrent().epochId,
        projectCount,
        threadCount,
        threadId: null,
      };
    }
    return {
      epochId: storage.metadata.getCurrent().epochId,
      projectCount,
      threadCount,
      threadId: thread.id,
      threadMessageCount: Number(thread.message_count),
      memoryCount: Number(thread.memory_count),
    };
  } finally {
    storage.close();
  }
}

async function getJson(url, token) {
  const response = await fetch(url, { headers: { "X-Shift-UI-Token": token } });
  return { status: response.status, body: await response.json() };
}

function inertWorktreeManager() {
  return {
    getStatus() {
      return {};
    },
    getDiff() {
      return "";
    },
    discardWorktree() {
      return { ok: true };
    },
  };
}

module.exports = { verifyRestoredSqliteApi, selectExpected };

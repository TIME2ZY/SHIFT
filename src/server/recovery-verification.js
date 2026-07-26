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

    const sessions = await getJson(`${baseUrl}/api/sessions`, token);
    checks.sessions = {
      ok: sessions.status === 200 && sessions.body.sessions?.length === expected.threadCount,
      status: sessions.status,
      expected: expected.threadCount,
      actual: sessions.body.sessions?.length ?? null,
    };

    if (expected.threadId) {
      const encoded = encodeURIComponent(expected.threadId);
      const messages = await getJson(`${baseUrl}/api/messages?sessionId=${encoded}`, token);
      checks.messages = {
        ok:
          messages.status === 200 &&
          messages.body.messages?.length === expected.threadMessageCount,
        status: messages.status,
        threadId: expected.threadId,
        expected: expected.threadMessageCount,
        actual: messages.body.messages?.length ?? null,
      };
      const memories = await getJson(`${baseUrl}/api/memories?sessionId=${encoded}`, token);
      checks.context = {
        ok:
          memories.status === 200 &&
          memories.body.memories?.length === expected.memoryCount &&
          Boolean(memories.body.context) &&
          Boolean(memories.body.context.digest) === expected.hasDigest &&
          memories.body.context.handoffs?.length === expected.handoffCount &&
          memories.body.context.pendingSuggestions?.length === expected.pendingSuggestionCount,
        status: memories.status,
        threadId: expected.threadId,
        expected: {
          memories: expected.memoryCount,
          digest: expected.hasDigest,
          handoffs: expected.handoffCount,
          pendingSuggestions: expected.pendingSuggestionCount,
        },
        actual: {
          memories: memories.body.memories?.length ?? null,
          digest: Boolean(memories.body.context?.digest),
          handoffs: memories.body.context?.handoffs?.length ?? null,
          pendingSuggestions: memories.body.context?.pendingSuggestions?.length ?? null,
        },
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
    const thread = storage.db
      .prepare(`
        SELECT t.id,
               (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count,
               (SELECT COUNT(*) FROM memory_entries memory
                WHERE memory.owner_thread_id = t.id OR memory.origin_thread_id = t.id) AS memory_count
        FROM threads t
        ORDER BY memory_count DESC, message_count DESC, t.created_at DESC, t.id
        LIMIT 1
      `)
      .get();
    if (!thread) {
      return {
        epochId: storage.metadata.getCurrent().epochId,
        threadCount: 0,
        threadId: null,
      };
    }
    return {
      epochId: storage.metadata.getCurrent().epochId,
      threadCount: Number(storage.db.prepare("SELECT COUNT(*) AS count FROM threads").get().count),
      threadId: thread.id,
      threadMessageCount: Number(thread.message_count),
      memoryCount: Number(thread.memory_count),
      hasDigest: Boolean(storage.digests.get(thread.id)),
      handoffCount: storage.memory.list(thread.id, {
        kinds: "handoff",
        includeRetired: false,
        limit: 10,
      }).length,
      pendingSuggestionCount: storage.suggestionService.list(thread.id, {
        status: "pending",
        includeProject: true,
        limit: 20,
      }).length,
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

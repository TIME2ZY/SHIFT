const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_MEMORY_DB_FILE,
  DEFAULT_SESSIONS_FILE,
  DEFAULT_TRANSCRIPT_DIR,
} = require("../shared/runtime-paths");
const { CANONICAL_EVENT_TYPES } = require("../agents/event-protocol");
const { createStorage } = require("./index");
const { readLegacySessions } = require("./legacy-session-reader");

const MIRRORED_EVENT_KINDS = new Set([
  ...CANONICAL_EVENT_TYPES,
  "invocation-start",
  "invocation-end",
]);

/**
 * Read-only divergence audit for artifacts from the retired `dual` storage era.
 *
 * This offline audit measures whether historical SQLite and legacy snapshots
 * drifted. It never repairs or changes either source.
 */
function auditDualStorage(options = {}) {
  const sessionsFile = options.sessionsFile || DEFAULT_SESSIONS_FILE;
  const transcriptDir = options.transcriptDir || DEFAULT_TRANSCRIPT_DIR;
  const memoryDbFile = options.memoryDbFile || DEFAULT_MEMORY_DB_FILE;
  const ownsStorage = !options.storage;

  if (ownsStorage && !fs.existsSync(memoryDbFile)) {
    throw new Error(`SQLite database does not exist: ${memoryDbFile}`);
  }

  const storage = options.storage || createStorage({ file: memoryDbFile });
  try {
    const findings = [];
    const fileSnapshot = collectFileSnapshot(sessionsFile, transcriptDir, findings);
    const sqliteSnapshot = collectSqliteSnapshot(storage);

    compareThreads(fileSnapshot, sqliteSnapshot, findings);
    compareInvocations(fileSnapshot, sqliteSnapshot, findings);

    return {
      ok: findings.every((finding) => finding.severity !== "error"),
      converged: findings.length === 0,
      sources: {
        sessionsFile: path.resolve(sessionsFile),
        transcriptDir: path.resolve(transcriptDir),
        memoryDbFile: ownsStorage ? path.resolve(memoryDbFile) : "(injected)",
      },
      totals: {
        files: snapshotTotals(fileSnapshot),
        sqlite: snapshotTotals(sqliteSnapshot),
      },
      metrics: buildCoverageMetrics(fileSnapshot, sqliteSnapshot),
      summary: summarizeFindings(findings),
      findings,
    };
  } finally {
    if (ownsStorage) storage.close();
  }
}

function collectFileSnapshot(sessionsFile, transcriptDir, findings) {
  validateSessionsJson(sessionsFile, findings);
  const data = readLegacySessions(sessionsFile);
  const threads = new Map();
  for (const [key, value] of Object.entries(data.sessions || {})) {
    const session = value && typeof value === "object" ? value : {};
    const id = typeof session.id === "string" && session.id ? session.id : key;
    const messages = new Map();
    for (const message of Array.isArray(session.messages) ? session.messages : []) {
      if (!message || typeof message !== "object") continue;
      if (typeof message.id !== "string" || !message.id) {
        findings.push({
          code: "file-message-missing-id",
          severity: "error",
          threadId: id,
          message: `file thread ${id} contains a message without a stable id`,
        });
        continue;
      }
      messages.set(message.id, normalizeFileMessage(message));
    }
    threads.set(id, {
      id,
      title: stringValue(session.title),
      createdAt: stringValue(session.createdAt),
      projectDir: stringValue(session.projectDir),
      lastAgent: stringValue(session.lastAgent),
      messages,
    });
  }

  return {
    threads,
    invocations: collectTranscriptInvocations(transcriptDir, findings),
  };
}

function validateSessionsJson(sessionsFile, findings) {
  if (!fs.existsSync(sessionsFile)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("root must be a JSON object");
    }
  } catch (error) {
    findings.push({
      code: "sessions-json-invalid",
      severity: "error",
      message: `sessions JSON is invalid: ${error.message}`,
    });
  }
}

function collectTranscriptInvocations(transcriptDir, findings) {
  const invocations = new Map();
  if (!fs.existsSync(transcriptDir)) return invocations;

  for (const threadEntry of safeReadDir(transcriptDir)) {
    if (!threadEntry.isDirectory()) continue;
    const threadId = threadEntry.name;
    const invocationDir = path.join(transcriptDir, threadId, "invocations");
    if (!fs.existsSync(invocationDir)) continue;

    for (const invocationEntry of safeReadDir(invocationDir)) {
      if (!invocationEntry.isFile() || path.extname(invocationEntry.name) !== ".jsonl") continue;
      const invocationId = path.basename(invocationEntry.name, ".jsonl");
      // Synthetic transcript lanes (for example `_user_prompt`) are
      // intentionally excluded by EventStore from SQLite.
      if (invocationId.startsWith("_")) continue;
      const file = path.join(invocationDir, invocationEntry.name);
      const events = [];
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event && typeof event.kind === "string" && event.kind) {
            if (MIRRORED_EVENT_KINDS.has(event.kind)) events.push(event.kind);
          } else {
            findings.push({
              code: "transcript-event-missing-kind",
              severity: "error",
              threadId,
              invocationId,
              line: index + 1,
              message: `transcript ${invocationId} line ${index + 1} has no event kind`,
            });
          }
        } catch (error) {
          findings.push({
            code: "transcript-json-invalid",
            severity: "error",
            threadId,
            invocationId,
            line: index + 1,
            message: `transcript ${invocationId} line ${index + 1} is invalid JSON: ${error.message}`,
          });
        }
      }
      invocations.set(invocationId, {
        id: invocationId,
        threadId,
        eventKinds: events,
      });
    }
  }
  return invocations;
}

function collectSqliteSnapshot(storage) {
  const activeThreads = storage.threads.listWithMessageCounts();
  const threads = new Map();
  const activeThreadIds = new Set();

  for (const thread of activeThreads) {
    activeThreadIds.add(thread.id);
    threads.set(thread.id, {
      id: thread.id,
      title: stringValue(thread.title),
      createdAt: stringValue(thread.createdAt),
      projectDir: stringValue(thread.projectDir),
      lastAgent: stringValue(thread.lastAgentId),
      messages: new Map(
        storage.messages
          .listForThread(thread.id)
          .map((message) => [message.id, normalizeSqliteMessage(message)])
      ),
    });
  }

  const invocations = new Map();
  for (const threadId of activeThreadIds) {
    for (const invocation of storage.invocations.listForThread(threadId)) {
      invocations.set(invocation.id, {
        id: invocation.id,
        threadId,
        eventKinds: storage.invocations.listEvents(invocation.id).map((event) => event.kind),
      });
    }
  }

  const archivedThreadIds = new Set(
    storage.db
      .prepare("SELECT id FROM threads WHERE deleted_at IS NOT NULL")
      .all()
      .map((row) => row.id)
  );

  return { threads, invocations, archivedThreadIds };
}

function compareThreads(files, sqlite, findings) {
  for (const [threadId, fileThread] of files.threads) {
    const sqliteThread = sqlite.threads.get(threadId);
    if (!sqliteThread) {
      const archived = sqlite.archivedThreadIds.has(threadId);
      findings.push({
        code: archived ? "file-thread-archived-in-sqlite" : "sqlite-thread-missing",
        severity: "error",
        threadId,
        message: archived
          ? `file thread ${threadId} is active while SQLite marks it archived`
          : `file thread ${threadId} is missing from active SQLite threads`,
      });
      continue;
    }

    compareField(threadId, "title", fileThread.title, sqliteThread.title, findings);
    compareField(threadId, "createdAt", fileThread.createdAt, sqliteThread.createdAt, findings);
    compareField(threadId, "projectDir", fileThread.projectDir, sqliteThread.projectDir, findings);
    compareField(threadId, "lastAgent", fileThread.lastAgent, sqliteThread.lastAgent, findings);
    compareMessages(threadId, fileThread.messages, sqliteThread.messages, findings);
  }

  for (const threadId of sqlite.threads.keys()) {
    if (files.threads.has(threadId)) continue;
    findings.push({
      code: "file-thread-missing",
      severity: "error",
      threadId,
      message: `active SQLite thread ${threadId} is missing from sessions JSON`,
    });
  }
}

function compareField(threadId, field, fileValue, sqliteValue, findings) {
  if (fileValue === sqliteValue) return;
  findings.push({
    code: "thread-metadata-mismatch",
    severity: "warn",
    threadId,
    field,
    fileValue,
    sqliteValue,
    message: `thread ${threadId} ${field} differs between sessions JSON and SQLite`,
  });
}

function compareMessages(threadId, fileMessages, sqliteMessages, findings) {
  for (const [messageId, fileMessage] of fileMessages) {
    const sqliteMessage = sqliteMessages.get(messageId);
    if (!sqliteMessage) {
      findings.push({
        code: "sqlite-message-missing",
        severity: "error",
        threadId,
        messageId,
        message: `file message ${messageId} is missing from SQLite`,
      });
      continue;
    }
    const changedFields = Object.keys(fileMessage).filter(
      (field) => fileMessage[field] !== sqliteMessage[field]
    );
    if (changedFields.length > 0) {
      findings.push({
        code: "message-content-mismatch",
        severity: "error",
        threadId,
        messageId,
        fields: changedFields,
        message: `message ${messageId} differs in ${changedFields.join(", ")}`,
      });
    }
  }

  for (const messageId of sqliteMessages.keys()) {
    if (fileMessages.has(messageId)) continue;
    findings.push({
      code: "file-message-missing",
      severity: "error",
      threadId,
      messageId,
      message: `SQLite message ${messageId} is missing from sessions JSON`,
    });
  }
}

function compareInvocations(files, sqlite, findings) {
  for (const [invocationId, fileInvocation] of files.invocations) {
    const sqliteInvocation = sqlite.invocations.get(invocationId);
    if (!sqliteInvocation) {
      // Archived threads intentionally have their online rows hidden and their
      // transcript directory may be removed asynchronously; do not report them.
      if (sqlite.archivedThreadIds.has(fileInvocation.threadId)) continue;
      findings.push({
        code: "sqlite-invocation-missing",
        severity: "error",
        threadId: fileInvocation.threadId,
        invocationId,
        message: `transcript invocation ${invocationId} is missing from SQLite`,
      });
      continue;
    }
    if (fileInvocation.threadId !== sqliteInvocation.threadId) {
      findings.push({
        code: "invocation-thread-mismatch",
        severity: "error",
        threadId: fileInvocation.threadId,
        invocationId,
        sqliteThreadId: sqliteInvocation.threadId,
        message: `invocation ${invocationId} belongs to different threads`,
      });
      continue;
    }

    const fileKinds = countKinds(fileInvocation.eventKinds);
    const sqliteKinds = countKinds(sqliteInvocation.eventKinds);
    if (!sameCounts(fileKinds, sqliteKinds)) {
      findings.push({
        code: "invocation-event-kinds-mismatch",
        severity: "error",
        threadId: fileInvocation.threadId,
        invocationId,
        fileKinds,
        sqliteKinds,
        message: `invocation ${invocationId} event kind counts differ`,
      });
    }
  }

  for (const [invocationId, invocation] of sqlite.invocations) {
    if (files.invocations.has(invocationId)) continue;
    findings.push({
      code: "transcript-invocation-missing",
      severity: "error",
      threadId: invocation.threadId,
      invocationId,
      message: `SQLite invocation ${invocationId} has no transcript JSONL`,
    });
  }
}

function normalizeFileMessage(message) {
  return {
    role: stringValue(message.role),
    agent: stringValue(message.agent),
    content: stringValue(message.content),
    createdAt: stringValue(message.createdAt),
    invocationId: stringValue(message.invocationId),
    messageType: normalizeMessageType(
      message.messageType,
      message.role,
      message.source,
      message.kind
    ),
  };
}

function normalizeSqliteMessage(message) {
  return {
    role: stringValue(message.role),
    agent: stringValue(message.agentId),
    content: stringValue(message.content),
    createdAt: stringValue(message.createdAt),
    invocationId: stringValue(message.invocationId),
    messageType: stringValue(message.messageType),
  };
}

function normalizeMessageType(value, role, source, kind) {
  if (typeof value === "string" && value) return value;
  if (role === "user") return "user";
  if (role === "assistant") return source === "callback" ? "assistant-callback" : "assistant-final";
  if (
    role === "system" &&
    new Set([
      "a2a-route",
      "a2a-skipped",
      "handoff-repair-needed",
      "memory-notice",
      "system-notice",
    ]).has(kind)
  ) {
    return kind;
  }
  return "system-notice";
}

function countKinds(kinds) {
  const counts = {};
  for (const kind of kinds) counts[kind] = (counts[kind] || 0) + 1;
  return counts;
}

function sameCounts(left, right) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if ((left[key] || 0) !== (right[key] || 0)) return false;
  }
  return true;
}

function snapshotTotals(snapshot) {
  let messages = 0;
  for (const thread of snapshot.threads.values()) messages += thread.messages.size;
  let events = 0;
  for (const invocation of snapshot.invocations.values()) events += invocation.eventKinds.length;
  return {
    threads: snapshot.threads.size,
    messages,
    invocations: snapshot.invocations.size,
    events,
  };
}

function buildCoverageMetrics(files, sqlite) {
  const fileMessageIds = collectMessageIds(files.threads);
  const sqliteMessageIds = collectMessageIds(sqlite.threads);
  const mirroredInvocationIds = intersectionSize(files.invocations, sqlite.invocations);
  let exactInvocationEvents = 0;
  for (const [invocationId, fileInvocation] of files.invocations) {
    const sqliteInvocation = sqlite.invocations.get(invocationId);
    if (
      sqliteInvocation &&
      fileInvocation.threadId === sqliteInvocation.threadId &&
      sameCounts(countKinds(fileInvocation.eventKinds), countKinds(sqliteInvocation.eventKinds))
    ) {
      exactInvocationEvents += 1;
    }
  }
  return {
    fileThreadsPresentInSqlite: ratio(
      intersectionSize(files.threads, sqlite.threads),
      files.threads.size
    ),
    sqliteThreadsPresentInFiles: ratio(
      intersectionSize(sqlite.threads, files.threads),
      sqlite.threads.size
    ),
    fileMessagesPresentInSqlite: ratio(
      intersectionSize(fileMessageIds, sqliteMessageIds),
      fileMessageIds.size
    ),
    sqliteMessagesPresentInFiles: ratio(
      intersectionSize(sqliteMessageIds, fileMessageIds),
      sqliteMessageIds.size
    ),
    fileInvocationsPresentInSqlite: ratio(mirroredInvocationIds, files.invocations.size),
    sqliteInvocationsPresentInFiles: ratio(mirroredInvocationIds, sqlite.invocations.size),
    mirroredInvocationsWithExactEventKinds: ratio(exactInvocationEvents, mirroredInvocationIds),
  };
}

function collectMessageIds(threads) {
  const ids = new Set();
  for (const thread of threads.values()) {
    for (const messageId of thread.messages.keys()) ids.add(messageId);
  }
  return ids;
}

function intersectionSize(left, right) {
  let count = 0;
  for (const key of left.keys()) {
    if (right.has(key)) count += 1;
  }
  return count;
}

function ratio(numerator, denominator) {
  if (denominator === 0) return 1;
  return Number((numerator / denominator).toFixed(6));
}

function summarizeFindings(findings) {
  const summary = {
    total: findings.length,
    errors: findings.filter((finding) => finding.severity === "error").length,
    warnings: findings.filter((finding) => finding.severity === "warn").length,
    byCode: {},
  };
  for (const finding of findings) {
    summary.byCode[finding.code] = (summary.byCode[finding.code] || 0) + 1;
  }
  return summary;
}

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

module.exports = {
  auditDualStorage,
  countKinds,
  normalizeFileMessage,
  normalizeSqliteMessage,
  ratio,
};

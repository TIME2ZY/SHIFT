const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isValidOpaqueId } = require("../server/id-policy");
const {
  DEFAULT_SESSIONS_FILE,
  DEFAULT_TRANSCRIPT_DIR,
  DEFAULT_MEMORY_DB_FILE,
} = require("../shared/runtime-paths");
const { durableMessageMetadata } = require("./message-persistence");
const { integrityCheck, rebuildThreadRecall } = require("./maintenance");

// Lazy require avoids circular load if tooling ever re-exports migrate from index.
function createStorage(options) {
  return require("./index").createStorage(options);
}

const DEFAULT_CAPACITY = 200_000;
const DEFAULT_RESERVE = 0.2;
const MIGRATION_PROVIDER = "migrated";
const MIGRATION_WORKSPACE = "migrated:runtime";

/**
 * Import sessions.json + transcript JSONL into SQLite.
 * Idempotent: re-running fills gaps and rebuilds recall projections.
 */
async function migrateRuntimeToSqlite(options = {}) {
  const sessionsFile = options.sessionsFile || DEFAULT_SESSIONS_FILE;
  const transcriptDir = options.transcriptDir || DEFAULT_TRANSCRIPT_DIR;
  const memoryDbFile = options.memoryDbFile || DEFAULT_MEMORY_DB_FILE;
  const dryRun = Boolean(options.dryRun);
  const logger = options.logger || console;
  const ownsStorage = !options.storage;
  const storage = options.storage || createStorage({ file: memoryDbFile });

  const report = {
    sessionsFile,
    transcriptDir,
    memoryDbFile: ownsStorage ? memoryDbFile : "(injected)",
    dryRun,
    threads: [],
    skipped: [],
    totals: {
      threads: 0,
      messagesImported: 0,
      messagesSkipped: 0,
      eventsImported: 0,
      eventsSkipped: 0,
      invocationsCreated: 0,
      memoriesImported: 0,
      recallRebuilt: 0,
    },
  };

  try {
    const sessions = loadSessions(sessionsFile);
    const transcriptThreads = listTranscriptThreadIds(transcriptDir);
    const threadIds = unionThreadIds(Object.keys(sessions), transcriptThreads);

    for (const threadId of threadIds) {
      if (!isValidOpaqueId(threadId) || threadId.startsWith("_")) {
        report.skipped.push({ threadId, reason: "invalid-or-synthetic-id" });
        continue;
      }

      const session = sessions[threadId] || null;
      const threadReport = await migrateThread({
        storage,
        threadId,
        session,
        transcriptDir,
        dryRun,
        logger,
      });
      report.threads.push(threadReport);
      report.totals.threads += 1;
      report.totals.messagesImported += threadReport.messagesImported;
      report.totals.messagesSkipped += threadReport.messagesSkipped;
      report.totals.eventsImported += threadReport.eventsImported;
      report.totals.eventsSkipped += threadReport.eventsSkipped;
      report.totals.invocationsCreated += threadReport.invocationsCreated;
      report.totals.memoriesImported += threadReport.memoriesImported;
      if (threadReport.recallRebuilt) report.totals.recallRebuilt += 1;
    }

    if (!dryRun) {
      report.integrity = integrityCheck(storage.db);
    }
    return report;
  } finally {
    if (ownsStorage) storage.close();
  }
}

async function migrateThread({ storage, threadId, session, transcriptDir, dryRun, logger }) {
  const report = {
    threadId,
    messagesImported: 0,
    messagesSkipped: 0,
    eventsImported: 0,
    eventsSkipped: 0,
    invocationsCreated: 0,
    memoriesImported: 0,
    recallRebuilt: false,
    diffs: [],
  };

  if (dryRun) {
    const fileMessages = Array.isArray(session?.messages) ? session.messages.length : 0;
    const sqliteMessages = storage.messages.listForThread(threadId).length;
    const invocationIds = listInvocationIds(transcriptDir, threadId);
    report.diffs.push({
      kind: "preview",
      fileMessages,
      sqliteMessages,
      fileInvocations: invocationIds.length,
      sqliteInvocations: storage.invocations.listForThread(threadId).length,
    });
    return report;
  }

  upsertThread(storage, threadId, session);

  const messages = Array.isArray(session?.messages) ? session.messages : [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      report.messagesSkipped += 1;
      continue;
    }
    const id =
      typeof message.id === "string" && message.id ? message.id : `${threadId}-msg-${index}`;
    const existing = storage.messages.get(id);
    if (existing) {
      report.messagesSkipped += 1;
      continue;
    }
    try {
      storage.messages.append({
        id,
        threadId,
        windowId: null,
        invocationId:
          typeof message.invocationId === "string" && storage.invocations.get(message.invocationId)
            ? message.invocationId
            : null,
        sequenceNo: index,
        role: message.role || "system",
        agentId: typeof message.agent === "string" ? message.agent : null,
        content: typeof message.content === "string" ? message.content : "",
        metadata: durableMessageMetadata(message),
        createdAt: message.createdAt || session?.createdAt || new Date().toISOString(),
        messageType: message.messageType,
      });
      report.messagesImported += 1;
    } catch (error) {
      report.messagesSkipped += 1;
      report.diffs.push({ kind: "message-error", id, error: error.message });
      logger.error?.(`[migrate] message ${id}: ${error.message}`);
    }
  }

  // Import invocations/events first so assistant messages can link later on re-run.
  const invocationSources = listInvocationIds(transcriptDir, threadId)
    .filter((id) => isValidOpaqueId(id) && !id.startsWith("_"))
    .map((invocationId) => {
      const events = readInvocationJsonl(transcriptDir, threadId, invocationId);
      const start = events.find((event) => event.kind === "invocation-start");
      return {
        invocationId,
        events,
        start,
        startedAt: start?.ts || events[0]?.ts || "",
      };
    })
    .filter((source) => source.events.length > 0)
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));

  for (const source of invocationSources) {
    const { invocationId, events, start } = source;
    const end = events.find((event) => event.kind === "invocation-end");
    const agentId =
      (start?.payload && (start.payload.agent || start.payload.agentId)) ||
      end?.payload?.agent ||
      "unknown";
    const startedAt = start?.ts || events[0]?.ts || new Date().toISOString();

    let invocation = storage.invocations.get(invocationId);
    if (!invocation) {
      const window = ensureMigrationWindow(storage, threadId, agentId);
      const requestedParentInvocationId =
        typeof start?.payload?.parentInvocationId === "string"
          ? start.payload.parentInvocationId
          : null;
      const parentInvocation = requestedParentInvocationId
        ? storage.invocations.get(requestedParentInvocationId)
        : null;
      const parentInvocationId =
        parentInvocation?.threadId === threadId ? parentInvocation.id : null;
      const requestedTriggerMessageId =
        typeof start?.payload?.triggerMessageId === "string"
          ? start.payload.triggerMessageId
          : null;
      const triggerMessage = requestedTriggerMessageId
        ? storage.messages.get(requestedTriggerMessageId)
        : null;
      const triggerMessageId = triggerMessage?.threadId === threadId ? triggerMessage.id : null;
      if (requestedParentInvocationId && !parentInvocationId) {
        report.diffs.push({
          kind: "causal-reference-missing",
          invocationId,
          field: "parentInvocationId",
          value: requestedParentInvocationId,
        });
      }
      if (requestedTriggerMessageId && !triggerMessageId) {
        report.diffs.push({
          kind: "causal-reference-missing",
          invocationId,
          field: "triggerMessageId",
          value: requestedTriggerMessageId,
        });
      }
      try {
        invocation = storage.invocations.start({
          id: invocationId,
          threadId,
          windowId: window.id,
          agentId: String(agentId),
          startedAt,
          parentInvocationId,
          triggerMessageId,
          triggerType:
            typeof start?.payload?.triggerType === "string" ? start.payload.triggerType : null,
        });
        report.invocationsCreated += 1;
      } catch (error) {
        report.diffs.push({
          kind: "invocation-error",
          invocationId,
          error: error.message,
        });
        logger.error?.(`[migrate] invocation ${invocationId}: ${error.message}`);
        continue;
      }
    }

    const existingEvents = storage.invocations.listEvents(invocationId);
    const existingBySeq = new Map(existingEvents.map((event) => [event.sequenceNo, event]));

    for (let sequenceNo = 0; sequenceNo < events.length; sequenceNo += 1) {
      const event = events[sequenceNo];
      if (!event || typeof event.kind !== "string" || !event.kind) {
        report.eventsSkipped += 1;
        continue;
      }
      if (existingBySeq.has(sequenceNo)) {
        report.eventsSkipped += 1;
        continue;
      }
      try {
        storage.invocations.appendEvent({
          invocationId,
          sequenceNo,
          kind: event.kind,
          payload: event.payload || {},
          createdAt: event.ts || startedAt,
        });
        report.eventsImported += 1;
      } catch (error) {
        report.eventsSkipped += 1;
        report.diffs.push({
          kind: "event-error",
          invocationId,
          sequenceNo,
          error: error.message,
        });
      }

      if (event.kind === "memory-captured" && event.payload?.captureKey) {
        const imported = importMemoryCapture(storage, threadId, event.payload, logger);
        if (imported) report.memoriesImported += 1;
      }
    }

    // Finalize terminal state from invocation-end when still active.
    invocation = storage.invocations.get(invocationId);
    if (invocation?.state === "active" && end) {
      const code = Number.isInteger(end.payload?.code) ? end.payload.code : 1;
      const signal = typeof end.payload?.signal === "string" ? end.payload.signal : null;
      const state = code === 0 ? "completed" : signal ? "aborted" : "failed";
      try {
        storage.invocations.finish(invocationId, {
          state,
          exitCode: code,
          signal,
          endedAt: end.ts || new Date().toISOString(),
        });
      } catch (error) {
        report.diffs.push({
          kind: "finish-error",
          invocationId,
          error: error.message,
        });
      }
    }
  }

  // Re-link assistant messages that were imported before their invocations.
  for (const message of messages) {
    if (!message?.invocationId || !message.id) continue;
    const stored = storage.messages.get(message.id);
    const inv = storage.invocations.get(message.invocationId);
    if (!stored || !inv || stored.invocationId) continue;
    try {
      storage.messages.append({
        id: stored.id,
        threadId: stored.threadId,
        windowId: inv.windowId || stored.windowId,
        invocationId: inv.id,
        sequenceNo: stored.sequenceNo,
        role: stored.role,
        agentId: stored.agentId,
        content: stored.content,
        metadata: stored.metadata,
        createdAt: stored.createdAt,
        messageType: stored.messageType,
      });
    } catch {
      // Best-effort relink; not fatal for migration.
    }
  }

  const rebuilt = rebuildThreadRecall(storage, threadId);
  report.recallRebuilt = true;
  report.diffs.push({
    kind: "summary",
    sqliteMessages: storage.messages.listForThread(threadId).length,
    sqliteInvocations: storage.invocations.listForThread(threadId).length,
    sqliteEvents: storage.db
      .prepare(
        `SELECT COUNT(*) AS count FROM invocation_events e
         JOIN invocations i ON i.id = e.invocation_id
         WHERE i.thread_id = ?`
      )
      .get(threadId).count,
    recall: rebuilt,
  });

  return report;
}

function upsertThread(storage, threadId, session) {
  const existing = storage.threads.get(threadId);
  const createdAt = session?.createdAt || existing?.createdAt || new Date().toISOString();
  storage.threads.upsert({
    id: threadId,
    title: session?.title || existing?.title || "",
    projectDir: session?.projectDir || existing?.projectDir || "",
    lastAgentId: session?.lastAgent || existing?.lastAgentId || null,
    createdAt,
    updatedAt: new Date().toISOString(),
  });
}

function ensureMigrationWindow(storage, threadId, agentId) {
  const coordinate = {
    threadId,
    agentId: String(agentId || "unknown"),
    providerKey: MIGRATION_PROVIDER,
    workspaceKey: MIGRATION_WORKSPACE,
  };
  const open = storage.windows.getOpen(coordinate);
  if (open) return open;
  // Prefer any existing window for this agent so messages can share context.
  const existing = storage.windows
    .listForThread(threadId)
    .find((window) => window.agentId === coordinate.agentId);
  if (existing) return existing;
  return storage.windows.create({
    id: crypto.randomUUID(),
    ...coordinate,
    generation: storage.windows.nextGeneration(coordinate) || 1,
    capacityTokens: DEFAULT_CAPACITY,
    reserveRatio: DEFAULT_RESERVE,
    providerSessionId: null,
  });
}

function importMemoryCapture(storage, threadId, payload, logger) {
  if (!storage.memory?.capture || !payload?.captureKey) return false;
  if (!["decision", "constraint", "fact"].includes(payload.kind)) return false;
  try {
    const existing = storage.memories.getByCaptureKey(threadId, payload.captureKey);
    if (existing) return false;
    // Drop live FKs that may not exist after partial history imports.
    storage.memory.capture({
      id: payload.id || crypto.randomUUID(),
      threadId,
      kind: payload.kind,
      content: typeof payload.content === "string" ? payload.content : "",
      sourceMessageId: null,
      sourceInvocationId: null,
      createdBy: payload.createdBy || "migration",
      createdAt: payload.createdAt || new Date().toISOString(),
      metadata: {
        ...(payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {}),
        migrated: true,
        replayedSourceMessageId: payload.sourceMessageId || null,
        replayedSourceInvocationId: payload.sourceInvocationId || null,
      },
      windowId: null,
      captureKey: payload.captureKey,
      supersessionKey: payload.supersessionKey || null,
    });
    return true;
  } catch (error) {
    logger.error?.(`[migrate] memory ${payload.captureKey}: ${error.message}`);
    return false;
  }
}

function loadSessions(sessionsFile) {
  if (!sessionsFile || !fs.existsSync(sessionsFile)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
    if (parsed?.sessions && typeof parsed.sessions === "object") return parsed.sessions;
    if (Array.isArray(parsed?.messages)) {
      // Legacy single-session file: skip auto-id migration here; import only when
      // an explicit sessions map is present.
      return {};
    }
    return {};
  } catch {
    return {};
  }
}

function listTranscriptThreadIds(transcriptDir) {
  if (!transcriptDir || !fs.existsSync(transcriptDir)) return [];
  return fs
    .readdirSync(transcriptDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => isValidOpaqueId(name) && !name.startsWith("_"));
}

function listInvocationIds(transcriptDir, threadId) {
  const dir = path.join(transcriptDir, threadId, "invocations");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => name.replace(/\.jsonl$/, ""));
}

function readInvocationJsonl(transcriptDir, threadId, invocationId) {
  const filePath = path.join(transcriptDir, threadId, "invocations", `${invocationId}.jsonl`);
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf8");
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function unionThreadIds(sessionIds, transcriptIds) {
  return [...new Set([...sessionIds, ...transcriptIds])].sort();
}

module.exports = {
  migrateRuntimeToSqlite,
  migrateThread,
  loadSessions,
  listTranscriptThreadIds,
  MIGRATION_PROVIDER,
  MIGRATION_WORKSPACE,
};

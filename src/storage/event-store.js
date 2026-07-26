const { eventPlainText } = require("./event-plain-text");

/**
 * Unified L1 event sink.
 *
 * modes:
 * - files  → transcript JSONL only
 * - dual   → SQLite + transcript JSONL
 * - sqlite → SQLite only (JSONL is optional audit/export, not online write)
 *
 * SQLite write failures always propagate so outer transactions can roll back.
 * Callers that want fail-open (dual stream path) must catch at their boundary.
 */
function createEventStore({
  storage = null,
  transcript = null,
  mode = "dual",
  logger = console,
} = {}) {
  if (!new Set(["files", "dual", "sqlite"]).has(mode)) {
    throw new Error(`Unsupported event-store mode "${mode}". Use files, dual, or sqlite.`);
  }

  const writeSqlite = (mode === "dual" || mode === "sqlite") && Boolean(storage);
  const writeTranscript = (mode === "files" || mode === "dual") && Boolean(transcript);
  const unavailableInvocations = new Set();
  const invocationThreads = new Map();
  const deletedThreads = new Set();

  function isSyntheticInvocation(invocationId) {
    return typeof invocationId !== "string" || !invocationId || invocationId.startsWith("_");
  }

  function resolveThreadId(threadId, invocationId) {
    if (threadId) return threadId;
    if (invocationId && invocationThreads.has(invocationId)) {
      return invocationThreads.get(invocationId);
    }
    if (!storage || !invocationId || isSyntheticInvocation(invocationId)) return null;
    try {
      const invocation = storage.invocations.get(invocationId);
      if (invocation?.threadId) {
        invocationThreads.set(invocationId, invocation.threadId);
        return invocation.threadId;
      }
    } catch (error) {
      logger.error?.(`[event-store] lookup invocation thread failed: ${error.message}`);
    }
    return null;
  }

  function markThreadDeleted(threadId) {
    if (!threadId) return;
    deletedThreads.add(threadId);
    for (const [invocationId, ownerThreadId] of invocationThreads) {
      if (ownerThreadId !== threadId) continue;
      unavailableInvocations.add(invocationId);
      invocationThreads.delete(invocationId);
    }
  }

  function registerInvocation(invocationId, threadId) {
    if (!invocationId || !threadId) return;
    invocationThreads.set(invocationId, threadId);
    unavailableInvocations.delete(invocationId);
  }

  function markInvocationUnavailable(invocationId) {
    if (invocationId) unavailableInvocations.add(invocationId);
  }

  function upsertInvocationRecall(event) {
    if (!storage?.recall || deletedThreads.has(event.threadId)) return null;
    return storage.recall.upsert({
      threadId: event.threadId,
      windowId: event.windowId,
      sourceKind: "invocation-event",
      sourceId: `${event.invocationId}:${event.sequenceNo}`,
      title: event.kind,
      content: eventPlainText(event.kind, event.payload || {}),
      agentId: event.agentId,
      createdAt: event.createdAt,
      metadata: {
        invocationId: event.invocationId,
        eventNo: event.sequenceNo,
        kind: event.kind,
      },
    });
  }

  /**
   * Append one invocation event to the configured sinks.
   *
   * @returns {{ ok: boolean, event: object|null, sqlite: boolean, transcript: boolean }}
   */
  function append(input = {}) {
    const invocationId = typeof input.invocationId === "string" ? input.invocationId : "";
    const kind = typeof input.kind === "string" ? input.kind : "";
    if (!invocationId || !kind) {
      return { ok: false, event: null, sqlite: false, transcript: false };
    }

    const payload = input.payload || {};
    const createdAt = input.createdAt || new Date().toISOString();
    const threadId = resolveThreadId(input.threadId, invocationId);
    const synthetic = isSyntheticInvocation(invocationId);

    const allowTranscript =
      input.writeTranscript === undefined ? writeTranscript : Boolean(input.writeTranscript);
    const allowSqlite =
      input.writeSqlite === undefined ? writeSqlite : Boolean(input.writeSqlite) && writeSqlite;

    let transcriptWritten = false;
    if (allowTranscript && threadId) {
      try {
        transcript.appendEvent(threadId, invocationId, kind, payload);
        transcriptWritten = true;
      } catch (error) {
        logger.error?.(`[event-store] transcript append failed: ${error.message}`);
      }
    }

    if (!allowSqlite || synthetic) {
      return {
        ok: transcriptWritten || (!allowSqlite && !allowTranscript),
        event: null,
        sqlite: false,
        transcript: transcriptWritten,
      };
    }

    if (unavailableInvocations.has(invocationId)) {
      return { ok: false, event: null, sqlite: false, transcript: transcriptWritten };
    }
    if (threadId && deletedThreads.has(threadId)) {
      return { ok: false, event: null, sqlite: false, transcript: transcriptWritten };
    }

    // Do not swallow SQLite errors: callers (and outer transactions) must see
    // failures so invocation rows cannot commit without their events/recall.
    const invocation = storage.invocations.get(invocationId);
    if (!invocation || deletedThreads.has(invocation.threadId)) {
      unavailableInvocations.add(invocationId);
      return { ok: false, event: null, sqlite: false, transcript: transcriptWritten };
    }
    invocationThreads.set(invocationId, invocation.threadId);

    const writeEvent = () => {
      const event = storage.invocations.appendEvent({
        invocationId,
        // Prefer DB atomic allocation unless an explicit sequence is provided
        // (migration / dual-write replay compatibility).
        ...(input.sequenceNo === undefined ? {} : { sequenceNo: input.sequenceNo }),
        kind,
        payload,
        createdAt,
      });
      upsertInvocationRecall({
        invocationId,
        sequenceNo: event.sequenceNo,
        kind,
        payload,
        threadId: invocation.threadId,
        windowId: invocation.windowId,
        agentId: invocation.agentId,
        createdAt: event.createdAt,
      });
      const outboxId =
        mode === "sqlite" && storage.outbox
          ? storage.outbox.enqueue({
              threadId: invocation.threadId,
              invocationId,
              sequenceNo: event.sequenceNo,
              kind,
              payload,
              createdAt: event.createdAt,
            })
          : null;
      return { event, outboxId };
    };

    // Nested transactions become savepoints under better-sqlite3, so this is
    // safe both standalone and when already inside start/finish transactions.
    // storage.transaction(fn) runs immediately and returns fn's result.
    const stored = storage.transaction(writeEvent);

    return {
      ok: true,
      event: stored.event,
      sqlite: true,
      transcript: transcriptWritten,
      outbox: Boolean(stored.outboxId),
      outboxId: stored.outboxId,
    };
  }

  function close() {
    unavailableInvocations.clear();
    invocationThreads.clear();
    deletedThreads.clear();
  }

  return {
    mode,
    enabled: writeSqlite || writeTranscript,
    writeSqlite,
    writeTranscript,
    append,
    registerInvocation,
    markInvocationUnavailable,
    markThreadDeleted,
    close,
  };
}

module.exports = { createEventStore };

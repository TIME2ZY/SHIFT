const crypto = require("node:crypto");
const { createEventStore } = require("./event-store");
const { DurableWriteError, withSqliteBusyRetry } = require("./sqlite-retry");

function createDurableRecorder({ storage, eventStore = null, logger = console } = {}) {
  if (!storage) {
    throw new Error("Durable recorder requires SQLite storage.");
  }
  const events =
    eventStore ||
    createEventStore({
      storage,
      logger,
    });
  /** Thread ids that were deleted during this process — block resurrection. */
  const deletedThreads = new Set();

  function attempt(operation, work) {
    try {
      return withSqliteBusyRetry(work, {
        operation: `sqlite-durable-write:${operation}`,
        logger,
      });
    } catch (error) {
      logger.error(`[sqlite-durable-write] ${operation} failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Best-effort terminal fail when a finish transaction cannot commit.
   * Avoids leaving invocations stuck in DB state=active after stream end.
   */
  function forceFailInvocation(invocationId, causeMessage) {
    if (!storage || !invocationId) return false;
    try {
      return withSqliteBusyRetry(
        () =>
          storage.transaction(() => {
            const existing = storage.invocations.get(invocationId);
            if (!existing || existing.state !== "active") return false;
            if (deletedThreads.has(existing.threadId)) {
              events.markInvocationUnavailable(invocationId);
              return false;
            }
            const record = storage.invocations.finish(invocationId, {
              state: "failed",
              exitCode: null,
              signal: null,
            });
            if (!record) return false;
            events.append({
              threadId: record.threadId,
              invocationId,
              kind: "invocation-end",
              payload: {
                code: null,
                signal: null,
                durableWriteFailed: true,
                cause: String(causeMessage || "").slice(0, 500),
              },
              createdAt: record.endedAt,
            });
            return true;
          }),
        {
          operation: "sqlite-durable-write:force-fail invocation",
          logger,
          maxAttempts: 3,
        }
      );
    } catch (error) {
      logger.error(
        `[sqlite-durable-write] force-fail ${invocationId} failed: ${error.message}`
      );
      return false;
    }
  }

  function rethrowAsDurableWrite(operation, error, invocationId = null) {
    if (error instanceof DurableWriteError) throw error;
    const forced = invocationId ? forceFailInvocation(invocationId, error.message) : false;
    const wrapped = new DurableWriteError(`Durable ${operation} failed: ${error.message}`, {
      code: "durable_write_failed",
      invocationId,
      cause: error,
      retryable: true,
    });
    wrapped.forcedTerminal = forced;
    throw wrapped;
  }

  function isThreadWritable(threadId) {
    return threadId && !deletedThreads.has(threadId);
  }

  function mirrorThread(session) {
    if (!session || !isThreadWritable(session.id)) return null;
    return attempt("mirror thread", () => {
      // Preserve durable metadata when the in-memory session snapshot is stale
      // (e.g. title/lastAgent already written via appendToSession).
      const existing =
        typeof storage.threads.get === "function" ? storage.threads.get(session.id) : null;
      return storage.threads.upsert({
        id: session.id,
        title: session.title || existing?.title || "",
        projectDir:
          typeof session.projectDir === "string" && session.projectDir
            ? session.projectDir
            : existing?.projectDir || "",
        lastAgentId: session.lastAgent || existing?.lastAgentId || null,
        createdAt: session.createdAt || existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
  }

  function ensureWindow(input) {
    if (!storage || !isThreadWritable(input.threadId)) return null;
    mirrorThread(input.session);
    return attempt("ensure context window", () => {
      const coordinate = {
        threadId: input.threadId,
        agentId: input.agentId,
        providerKey: input.providerKey,
        workspaceKey: input.workspaceKey,
      };
      const existing = storage.windows.getOpen(coordinate);
      if (existing) {
        // Capacity is fixed at window creation; do not rewrite on re-entry.
        return existing;
      }
      return storage.windows.create({
        id: crypto.randomUUID(),
        ...coordinate,
        generation: storage.windows.nextGeneration(coordinate),
        capacityTokens: input.capacityTokens,
        reserveRatio: input.reserveRatio,
        providerSessionId: null,
      });
    });
  }

  function sealWindow(windowId, reason = "context overflow") {
    if (!storage || !windowId) return null;
    return attempt("seal context window", () =>
      storage.windows.seal(windowId, { reason, sealedAt: new Date().toISOString() })
    );
  }

  /**
   * Seal the open window for a coordinate and open generation N+1 in one
   * transaction. The new window never inherits the sealed provider session.
   */
  function sealAndRotateWindow(input) {
    if (!storage || !isThreadWritable(input.threadId)) return null;
    mirrorThread(input.session);
    return attempt("seal and rotate context window", () =>
      storage.windows.sealAndRotate({
        threadId: input.threadId,
        agentId: input.agentId,
        providerKey: input.providerKey,
        workspaceKey: input.workspaceKey,
        capacityTokens: input.capacityTokens,
        reserveRatio: input.reserveRatio,
        reason: input.reason || "context overflow",
        windowId: input.windowId || null,
        nextId: input.nextId || crypto.randomUUID(),
        sealedAt: input.sealedAt || new Date().toISOString(),
      })
    );
  }

  function mirrorLastMessage(session, context = {}) {
    if (!storage || !session || !isThreadWritable(session.id)) return null;
    if (!Array.isArray(session.messages) || session.messages.length === 0) return null;
    mirrorThread(session);
    return attempt("mirror message", () =>
      storage.transaction(() => {
        const message = session.messages[session.messages.length - 1];
        const invocation = context.invocationId
          ? storage.invocations.get(context.invocationId)
          : null;
        const stored = storage.messages.append({
          id: message.id,
          threadId: session.id,
          windowId: context.windowId || invocation?.windowId || null,
          invocationId: invocation?.id || null,
          sequenceNo: session.messages.length - 1,
          role: message.role || "system",
          agentId: message.agent || null,
          content: typeof message.content === "string" ? message.content : "",
          metadata: durableMessageMetadata(message),
          createdAt: message.createdAt,
          messageType: message.messageType,
        });
        upsertMessageRecall(stored);
        return stored;
      })
    );
  }

  function startInvocation(input) {
    if (!storage || !isThreadWritable(input.threadId)) {
      if (input.invocationId) events.markInvocationUnavailable(input.invocationId);
      return null;
    }
    const window = ensureWindow(input);
    if (!window) {
      events.markInvocationUnavailable(input.invocationId);
      return null;
    }
    // Only bind resume when the open window already carries that provider
    // session, or when the caller is first-binding mid-window. Never attach a
    // resume id to a brand-new generation that has no provider session yet
    // unless the caller explicitly supplies one for this generation (cold
    // start after seal should pass empty resumeSessionId).
    const resumeSessionId =
      typeof input.resumeSessionId === "string" && input.resumeSessionId
        ? input.resumeSessionId
        : null;
    const invocation = attempt("start invocation", () => {
      const started = storage.transaction(() => {
        if (resumeSessionId) {
          storage.windows.bindProviderSession(window.id, resumeSessionId);
        }
        const record = storage.invocations.start({
          id: input.invocationId,
          threadId: input.threadId,
          windowId: window.id,
          agentId: input.agentId,
          startedAt: input.startedAt,
          parentInvocationId: input.parentInvocationId,
          triggerMessageId: input.triggerMessageId,
          triggerType: input.triggerType,
        });
        events.registerInvocation(input.invocationId, input.threadId);
        // Invocation start and its first event commit atomically.
        events.append({
          threadId: input.threadId,
          invocationId: input.invocationId,
          kind: "invocation-start",
          payload: {
            agent: input.agentId,
            resumeSessionId: resumeSessionId || null,
            windowGeneration: window.generation,
            parentInvocationId: input.parentInvocationId || null,
            triggerMessageId: input.triggerMessageId || null,
            triggerType: input.triggerType || null,
          },
          createdAt: input.startedAt,
          sequenceNo: 0,
        });
        return record;
      });
      return started;
    });
    if (!invocation) events.markInvocationUnavailable(input.invocationId);
    else {
      events.registerInvocation(input.invocationId, input.threadId);
      const refreshed = storage.windows.get(window.id) || window;
      return { invocation, window: refreshed };
    }
    return null;
  }

  function appendInvocationEvent(invocationId, kind, payload, options = {}) {
    const result = events.append({
      invocationId,
      kind,
      payload,
      ...options,
    });
    return result.sqlite === true;
  }

  function finishInvocation(invocationId, code, signal, endPayload = null) {
    if (!storage) return null;
    try {
      return attempt("finish invocation", () =>
        storage.transaction(() => {
          const existing = storage.invocations.get(invocationId);
          if (!existing || deletedThreads.has(existing.threadId)) {
            events.markInvocationUnavailable(invocationId);
            return null;
          }
          const state = code === 0 ? "completed" : signal ? "aborted" : "failed";
          const record = storage.invocations.finish(invocationId, {
            state,
            exitCode: code,
            signal,
          });
          if (!record) throw new Error(`Invocation ${invocationId} is not active.`);
          const payload =
            endPayload && typeof endPayload === "object"
              ? { code, signal, ...endPayload }
              : { code, signal };
          events.append({
            threadId: record.threadId,
            invocationId,
            kind: "invocation-end",
            payload,
            createdAt: record.endedAt,
          });
          return record;
        })
      );
    } catch (error) {
      rethrowAsDurableWrite("finish invocation", error, invocationId);
    }
  }

  /**
   * Finish an invocation and append the assistant-final message in one SQLite
   * transaction (plus EventStore sinks for invocation-end).
   */
  function finishWithAssistantMessage(input = {}) {
    if (!storage) return null;
    const invocationId = input.invocationId;
    if (!invocationId) return null;
    const finish = () =>
      storage.transaction(() => {
        const existing = storage.invocations.get(invocationId);
        if (!existing || deletedThreads.has(existing.threadId)) {
          events.markInvocationUnavailable(invocationId);
          return null;
        }
        const code = input.code;
        const signal = input.signal;
        const state = code === 0 ? "completed" : signal ? "aborted" : "failed";
        const record = storage.invocations.finish(invocationId, {
          state,
          exitCode: code,
          signal,
          endedAt: input.endedAt,
        });
        if (!record) throw new Error(`Invocation ${invocationId} is not active.`);

        const payload =
          input.endPayload && typeof input.endPayload === "object"
            ? { code, signal, ...input.endPayload }
            : { code, signal };
        events.append({
          threadId: record.threadId,
          invocationId,
          kind: "invocation-end",
          payload,
          createdAt: record.endedAt,
        });

        let message = null;
        if (input.message) {
          const session = input.session;
          const threadId = session?.id || record.threadId;
          if (threadId && isThreadWritable(threadId)) {
            if (session) mirrorThread(session);
            const msg = input.message;
            const messageId =
              typeof msg.id === "string" && msg.id
                ? msg.id
                : crypto.randomUUID().replace(/-/g, "").slice(0, 18);
            message = storage.messages.append({
              id: messageId,
              threadId,
              windowId: input.windowId || record.windowId || null,
              invocationId,
              role: msg.role || "assistant",
              agentId: msg.agent || record.agentId,
              content: typeof msg.content === "string" ? msg.content : "",
              metadata: durableMessageMetadata({ ...msg, id: messageId }),
              createdAt: msg.createdAt || record.endedAt,
              messageType: msg.messageType || "assistant-final",
            });
            upsertMessageRecall(message);
            // lastAgent tracks the user's chosen entry agent, not the last
            // responding agent in an A2A chain — do not update it here.
            const existing = storage.threads.get(threadId);
            if (existing) {
              storage.threads.upsert({
                id: threadId,
                title: existing.title || "",
                projectDir: existing.projectDir || "",
                lastAgentId: existing.lastAgentId,
                createdAt: existing.createdAt,
                updatedAt: new Date().toISOString(),
              });
            }
          }
        }

        return { invocation: record, message };
      });
    try {
      return attempt("finish with assistant message", finish);
    } catch (error) {
      rethrowAsDurableWrite("finish with assistant message", error, invocationId);
    }
  }

  function bindProviderSession(windowId, providerSessionId) {
    if (!providerSessionId || !windowId) return false;
    return (
      attempt("bind provider session", () =>
        storage.windows.bindProviderSession(windowId, providerSessionId)
      ) === true
    );
  }

  function addWindowUsage(windowId, usage) {
    return attempt("update window usage", () => storage.windows.addUsage(windowId, usage)) === true;
  }

  function setWindowUsageSnapshot(windowId, usage) {
    return (
      attempt("set window usage snapshot", () =>
        storage.windows.setUsageSnapshot(windowId, usage)
      ) === true
    );
  }

  function deleteThread(threadId) {
    if (!threadId) return null;
    deletedThreads.add(threadId);
    events.markThreadDeleted(threadId);
    return attempt("delete thread", () => storage.threads.delete(threadId));
  }

  function close() {
    deletedThreads.clear();
    if (eventStore !== events) events.close();
  }

  function upsertMessageRecall(message) {
    if (!storage.recall || deletedThreads.has(message.threadId)) return null;
    return storage.recall.upsert({
      threadId: message.threadId,
      windowId: message.windowId,
      sourceKind: "message",
      sourceId: message.id,
      title: `${message.role}${message.agentId ? `:${message.agentId}` : ""}`,
      content: message.content,
      agentId: message.agentId,
      createdAt: message.createdAt,
      metadata: {
        invocationId: message.invocationId,
        sequenceNo: message.sequenceNo,
        role: message.role,
        messageType: message.messageType,
      },
    });
  }

  return {
    enabled: Boolean(storage),
    eventStore: events,
    mirrorThread,
    ensureWindow,
    sealWindow,
    sealAndRotateWindow,
    mirrorLastMessage,
    startInvocation,
    appendInvocationEvent,
    finishInvocation,
    finishWithAssistantMessage,
    bindProviderSession,
    addWindowUsage,
    setWindowUsageSnapshot,
    deleteThread,
    close,
  };
}

function durableMessageMetadata(message) {
  const excluded = new Set(["id", "role", "agent", "content", "createdAt", "messageType"]);
  const metadata = {};
  for (const [key, value] of Object.entries(message)) {
    if (!excluded.has(key)) metadata[key] = value;
  }
  return Object.keys(metadata).length > 0 ? metadata : null;
}

module.exports = { createDurableRecorder, durableMessageMetadata, DurableWriteError };

const crypto = require("node:crypto");
const { createEventStore } = require("./event-store");
const { isTerminalInvocationState } = require("../shared/collab-contracts");
const { appendMessage, durableMessageMetadata } = require("./message-persistence");
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
  /**
   * Force an open invocation to a terminal DB state (failed|aborted|completed).
   * @returns {object|null} finished invocation row, or null if already terminal / missing
   */
  function forceTerminalInvocation(invocationId, options = {}) {
    if (!storage || !invocationId) return null;
    const terminalState =
      options.state === "aborted" || options.state === "completed" || options.state === "failed"
        ? options.state
        : "failed";
    const reason = String(options.reason || options.causeMessage || "force-terminal").slice(0, 200);
    try {
      return withSqliteBusyRetry(
        () =>
          storage.transaction(() => {
            const existing = storage.invocations.get(invocationId);
            if (!existing) return null;
            if (existing.state !== "active") return null;
            if (deletedThreads.has(existing.threadId)) {
              events.markInvocationUnavailable(invocationId);
              return null;
            }
            const record = storage.invocations.finish(invocationId, {
              state: terminalState,
              exitCode: Number.isInteger(options.exitCode) ? options.exitCode : null,
              signal: options.signal || null,
            });
            if (!record) return null;
            events.append({
              threadId: record.threadId,
              invocationId,
              kind: "invocation-end",
              payload: {
                code: options.exitCode ?? null,
                signal: options.signal || null,
                forcedTerminal: true,
                reason,
                durableWriteFailed: Boolean(options.durableWriteFailed),
                cause: String(options.causeMessage || reason).slice(0, 500),
              },
              createdAt: record.endedAt,
            });
            return record;
          }),
        {
          operation: "sqlite-durable-write:force-terminal invocation",
          logger,
          maxAttempts: 3,
        }
      );
    } catch (error) {
      logger.error(
        `[sqlite-durable-write] force-terminal ${invocationId} failed: ${error.message}`
      );
      return null;
    }
  }

  function forceFailInvocation(invocationId, causeMessage) {
    return Boolean(
      forceTerminalInvocation(invocationId, {
        state: "failed",
        reason: "durable-write-failed",
        causeMessage,
        durableWriteFailed: true,
      })
    );
  }

  /**
   * Close every still-active invocation on a thread (request-done / abort orphan cleanup).
   * @param {string} threadId
   * @param {{ reason?: string, exceptIds?: string[], state?: string }} [options]
   */
  function reconcileThreadActive(threadId, options = {}) {
    const report = {
      threadId,
      reason: options.reason || "reconcile-thread-active",
      forced: [],
      skipped: [],
      remainingActive: 0,
    };
    if (!storage || !threadId || deletedThreads.has(threadId)) return report;
    const except = new Set((options.exceptIds || []).filter((id) => typeof id === "string" && id));
    const listFn =
      typeof storage.invocations.listActiveForThread === "function"
        ? () => storage.invocations.listActiveForThread(threadId)
        : () => storage.invocations.listForThread(threadId).filter((row) => row.state === "active");
    let open;
    try {
      open = listFn();
    } catch (error) {
      logger.error?.(`[sqlite-durable-write] list active failed: ${error.message}`);
      return report;
    }
    for (const inv of open) {
      if (except.has(inv.id)) {
        report.skipped.push({ id: inv.id, reason: "excepted" });
        continue;
      }
      const finished = forceTerminalInvocation(inv.id, {
        state: options.state || "failed",
        reason: report.reason,
        causeMessage: report.reason,
      });
      if (finished) {
        report.forced.push({
          id: finished.id,
          agentId: finished.agentId,
          state: finished.state,
        });
      } else {
        report.skipped.push({ id: inv.id, reason: "already-terminal-or-missing" });
      }
    }
    try {
      report.remainingActive =
        typeof storage.invocations.listActiveForThread === "function"
          ? storage.invocations.listActiveForThread(threadId).length
          : storage.invocations.listForThread(threadId).filter((r) => r.state === "active").length;
    } catch {
      report.remainingActive = -1;
    }
    if (report.forced.length) {
      logger.warn?.(
        `[sqlite-durable-write] reconciled ${report.forced.length} open invocation(s) ` +
          `on thread ${threadId} (${report.reason})`
      );
    }
    return report;
  }

  function listOpenInvocations(threadId) {
    if (!storage || !threadId) return [];
    if (typeof storage.invocations.listActiveForThread === "function") {
      return storage.invocations.listActiveForThread(threadId);
    }
    return storage.invocations.listForThread(threadId).filter((row) => row.state === "active");
  }

  function isInvocationOpen(invocationId) {
    if (!storage || !invocationId) return false;
    const row = storage.invocations.get(invocationId);
    if (!row) return false;
    if (row.isOpen === true) return true;
    if (row.isTerminal === true) return false;
    return row.state === "active" || !isTerminalInvocationState(row.state);
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
   * Force-terminal any still-active invocations bound to a sealed window.
   */
  function terminateInvocationsForWindow(windowId, reason = "window-sealed") {
    if (!storage || !windowId) return [];
    const forced = [];
    try {
      const window = storage.windows.get(windowId);
      const threadId = window?.threadId;
      if (!threadId || typeof storage.invocations.listForThread !== "function") return forced;
      for (const inv of storage.invocations.listForThread(threadId)) {
        if (inv.state !== "active") continue;
        if (inv.windowId !== windowId) continue;
        const row = forceTerminalInvocation(inv.id, {
          state: "failed",
          reason,
          causeMessage: reason,
        });
        if (row) forced.push(row.id);
      }
    } catch (error) {
      logger.warn?.(`[sqlite-durable-write] terminate window invs failed: ${error.message}`);
    }
    return forced;
  }

  /**
   * Seal the open window for a coordinate and open generation N+1 in one
   * transaction. The new window never inherits the sealed provider session.
   * capacityTokens should be the **current** live capacity (not sticky old gen).
   */
  function sealAndRotateWindow(input) {
    if (!storage || !isThreadWritable(input.threadId)) return null;
    mirrorThread(input.session);
    const reason = input.reason || "context overflow";
    const result = attempt("seal and rotate context window", () =>
      storage.windows.sealAndRotate({
        threadId: input.threadId,
        agentId: input.agentId,
        providerKey: input.providerKey,
        workspaceKey: input.workspaceKey,
        capacityTokens: input.capacityTokens,
        reserveRatio: input.reserveRatio,
        reason,
        windowId: input.windowId || null,
        nextId: input.nextId || crypto.randomUUID(),
        sealedAt: input.sealedAt || new Date().toISOString(),
      })
    );
    // Seal completeness: open invocations on the sealed generation must not stay active.
    if (result?.sealed?.id) {
      const terminated = terminateInvocationsForWindow(result.sealed.id, `window-sealed:${reason}`);
      if (terminated.length) {
        logger.warn?.(
          `[sqlite-durable-write] sealed window ${result.sealed.id} terminated ${terminated.length} open invocation(s)`
        );
      }
      result.terminatedInvocationIds = terminated;
    }
    return result;
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
        const stored = appendMessage(storage, {
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
          const state = resolveFinishDbState(code, signal, endPayload);
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
        const state = resolveFinishDbState(code, signal, input.endPayload);
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
            message = appendMessage(storage, {
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

  function archiveThread(threadId) {
    if (!threadId) return null;
    deletedThreads.add(threadId);
    events.markThreadDeleted(threadId);
    return attempt("archive thread", () => storage.threads.delete(threadId));
  }

  function close() {
    deletedThreads.clear();
    if (eventStore !== events) events.close();
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
    forceTerminalInvocation,
    forceFailInvocation,
    reconcileThreadActive,
    listOpenInvocations,
    isInvocationOpen,
    bindProviderSession,
    addWindowUsage,
    setWindowUsageSnapshot,
    archiveThread,
    close,
  };
}

/** Map provider exit to DB terminal state (CHECK: completed|failed|aborted). */
function resolveFinishDbState(code, signal, endPayload) {
  if (endPayload && typeof endPayload === "object") {
    const explicit = endPayload.terminalState || endPayload.dbState;
    if (explicit === "completed" || explicit === "failed" || explicit === "aborted") {
      return explicit;
    }
  }
  if (code === 0) return "completed";
  if (signal) return "aborted";
  return "failed";
}

module.exports = { createDurableRecorder, DurableWriteError };

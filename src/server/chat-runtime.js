"use strict";

const AGENT_EVENT_KINDS = new Set([
  "text.delta",
  "commentary.delta",
  "thinking.delta",
  "tool.started",
  "tool.finished",
  "file.changed",
  "progress.update",
  "run.failed",
  "usage.update",
  "run.started",
]);

function toSseFrame(event) {
  if (!event || typeof event !== "object") return null;
  const invocationId = event.invocationId || event.payload?.invocationId || null;
  const serverTime =
    event.createdAt ||
    event.payload?.createdAt ||
    event.ts ||
    event.payload?.ts ||
    new Date().toISOString();
  if (AGENT_EVENT_KINDS.has(event.kind)) {
    return {
      id: event.id ?? null,
      event: "agent-event",
      data: {
        ...(event.payload || {}),
        type: event.kind,
        invocationId,
        traceId: event.traceId || null,
        ts: serverTime,
        createdAt: serverTime,
      },
    };
  }
  return {
    id: event.id ?? null,
    event: event.kind,
    data: {
      ...(event.payload || {}),
      invocationId,
      traceId: event.traceId || null,
      ts: serverTime,
      createdAt: serverTime,
    },
  };
}

function createChatRuntime({ eventStore } = {}) {
  const runs = new Map();
  // Waiters include superseded runs and preparation, not just the current Seat run.
  const pending = new Set();
  const subscribers = new Map();
  let executor = null;
  let closing = false;

  function publish(sessionId, event) {
    if (!sessionId || !event) return;
    const set = subscribers.get(sessionId);
    if (!set || set.size === 0) return;
    for (const subscriber of set) {
      try {
        subscriber.onEvent(event);
      } catch {
        // Observer IO is best-effort; SQLite remains the truth.
      }
    }
  }

  if (eventStore && typeof eventStore.append === "function" && !eventStore.__runPublisherAttached) {
    const original = eventStore.append.bind(eventStore);
    eventStore.append = function appendAndPublish(input) {
      const result = original(input);
      if (result?.ok && result.event) {
        const sessionId = input.threadId || null;
        if (sessionId) publish(sessionId, result.event);
      }
      return result;
    };
    eventStore.__runPublisherAttached = true;
  }

  function subscribe(sessionId, subscriber) {
    if (!sessionId || !subscriber) return () => {};
    let set = subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      subscribers.set(sessionId, set);
    }
    set.add(subscriber);
    return () => {
      set.delete(subscriber);
      if (set.size === 0) subscribers.delete(sessionId);
    };
  }

  function claim(sessionId, { traceId, controller, clientTurnId } = {}) {
    const existing = runs.get(sessionId);
    if (existing) {
      existing.supersededByClientTurnId = clientTurnId || null;
      existing.stopReason = "supersede";
      try {
        existing.controller.abort();
      } catch {
        // already aborted
      }
    }
    const record = {
      sessionId,
      traceId,
      controller,
      promise: null,
      stopReason: null,
      supersededByClientTurnId: null,
      startedAt: Date.now(),
    };
    runs.set(sessionId, record);
    return record;
  }

  function attachPromise(sessionId, promise) {
    const record = runs.get(sessionId);
    if (!record) return promise;
    record.promise = Promise.resolve(promise).finally(() => {
      const current = runs.get(sessionId);
      if (current && current.controller === record.controller) {
        runs.delete(sessionId);
      }
    });
    track(record.promise);
    return record.promise;
  }

  function track(promise) {
    const waiter = Promise.resolve(promise)
      .catch(() => {
        // Shutdown waiter only; callers handle failure and persist the terminal.
      })
      .finally(() => pending.delete(waiter));
    pending.add(waiter);
    return waiter;
  }

  function getRun(sessionId) {
    return runs.get(sessionId) || null;
  }

  function stopRun(sessionId, traceId) {
    const record = runs.get(sessionId);
    if (!record) {
      return { stopped: false, reason: "trace_not_active" };
    }
    if (traceId && record.traceId && record.traceId !== traceId) {
      return { stopped: false, reason: "trace_not_active" };
    }
    record.stopReason = "explicit-stop";
    try {
      if (record.controller) {
        record.controller.stopReason = "explicit-stop";
        record.controller.abort("explicit-stop");
      }
    } catch {
      // already aborted
    }
    return { stopped: true, traceId: record.traceId || traceId };
  }

  function closeSubscriberSet(set) {
    for (const subscriber of set) {
      try {
        subscriber.close?.();
      } catch {
        // Observer IO is best-effort; SQLite remains the truth.
      }
    }
  }

  function closeSession(sessionId) {
    const set = subscribers.get(sessionId);
    if (!set) return;
    subscribers.delete(sessionId);
    closeSubscriberSet(set);
  }

  function closeSubscribers() {
    const pending = [];
    for (const set of subscribers.values()) pending.push(...set);
    subscribers.clear();
    closeSubscriberSet(pending);
  }

  async function shutdown() {
    closing = true;
    for (const record of runs.values()) {
      record.stopReason = "server-shutdown";
      try {
        record.controller.abort();
      } catch {
        // already aborted
      }
    }
    // Preparation may attach a background run while shutdown is awaiting it.
    while (pending.size) await Promise.all([...pending]);
    closeSubscribers();
  }

  function attachExecutor(next) {
    executor = next;
  }

  async function startRun(input) {
    if (closing) {
      return { status: 503, json: { error: "Server is shutting down." } };
    }
    if (!executor || typeof executor.startRun !== "function") {
      throw new Error("chat runtime executor is not attached");
    }
    const previous = runs.get(input?.body?.sessionId);
    const preparation = executor.startRun(input);
    // The executor claims synchronously, before its first asynchronous preparation.
    const record = runs.get(input?.body?.sessionId);
    const completion = Promise.resolve(preparation).finally(() => {
      if (
        record &&
        record !== previous &&
        !record.promise &&
        runs.get(record.sessionId) === record
      ) {
        runs.delete(record.sessionId);
      }
    });
    track(completion);
    return completion;
  }

  return {
    claim,
    attachPromise,
    getRun,
    stopRun,
    subscribe,
    publish,
    closeSession,
    shutdown,
    attachExecutor,
    startRun,
    toSseFrame,
    runs,
    get closing() {
      return closing;
    },
  };
}

module.exports = { AGENT_EVENT_KINDS, createChatRuntime, toSseFrame };

const { PRODUCT_KINDS } = require("../storage/memory-keys");
const {
  emptyWriteStats,
  buildMemoryWriteMetrics,
  logMemoryWriteMetrics,
} = require("../storage/memory-metrics");

const MAX_MEMORY_CONTENT_CHARS = 2048;

function bumpThreadWriteStat(callbacks, sessionId, field, amount = 1) {
  const thread = typeof callbacks.getThread === "function" ? callbacks.getThread(sessionId) : null;
  if (!thread) return emptyWriteStats();
  if (!thread.memoryWriteStats) thread.memoryWriteStats = emptyWriteStats();
  thread.memoryWriteStats[field] = (Number(thread.memoryWriteStats[field]) || 0) + amount;
  return { ...thread.memoryWriteStats };
}

function countHitLayers(hits) {
  const layers = { memory: 0, message: 0, evidence: 0, "project-doc": 0 };
  for (const hit of hits || []) {
    const layer = hit.layer || "evidence";
    if (layers[layer] !== undefined) layers[layer] += 1;
  }
  return layers;
}

function validateOptionalCallbackAuth({
  sessionId,
  invocationId,
  callbackToken,
  callbacks,
  sendJson,
  res,
}) {
  if (!(invocationId || callbackToken)) return true;
  if (!invocationId || !callbackToken) {
    sendJson(res, 400, { error: "invocationId and X-Callback-Token must be provided together." });
    return false;
  }
  if (!callbacks.validateToken(sessionId, invocationId, callbackToken)) {
    sendJson(res, 401, { error: "Invalid callback token." });
    return false;
  }
  return true;
}

function resolveAgentId(callbacks, sessionId, invocationId) {
  const thread = typeof callbacks.getThread === "function" ? callbacks.getThread(sessionId) : null;
  const record = thread?.tokens?.get(invocationId);
  if (record && typeof record.agentId === "string" && record.agentId.trim()) {
    return record.agentId.trim();
  }
  return "agent";
}

function broadcastMemoryEvent(callbacks, sessionId, payload) {
  const thread = typeof callbacks.getThread === "function" ? callbacks.getThread(sessionId) : null;
  if (!thread?.res || typeof callbacks.sendSse !== "function") return false;
  return callbacks.sendSse(thread.res, "memory", payload);
}

function appendMemoryCapturedEvent(eventStore, sessionId, invocationId, memory, created) {
  if (!eventStore || typeof eventStore.append !== "function" || !invocationId) return;
  eventStore.append({
    threadId: sessionId,
    invocationId,
    kind: "memory-captured",
    payload: {
      id: memory.id,
      threadId: sessionId,
      kind: memory.kind,
      status: memory.status,
      content: memory.content,
      captureKey: memory.captureKey,
      supersessionKey: memory.supersessionKey,
      createdBy: memory.createdBy,
      createdAt: memory.createdAt,
      persisted: true,
      created: Boolean(created),
      source: "callback:memory-upsert",
    },
  });
}

function createCallbackRoutes({
  callbacks,
  transcript,
  appendToSession,
  getSession,
  sessionsFile,
  sendJson,
  readJsonBody,
  durableRecorder,
  recallService,
  memoryCapture,
  memoryService = null,
  eventStore = null,
  logger = console,
}) {
  const recall = recallService || transcript;
  return async function handleCallbackRoutes(req, res, url) {
    if (req.method === "POST" && url.pathname === "/api/callbacks/post-message") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return true;
      }

      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const invocationId = typeof body.invocationId === "string" ? body.invocationId : "";
      const callbackToken = typeof body.callbackToken === "string" ? body.callbackToken : "";
      const content = typeof body.content === "string" ? body.content : "";

      if (!sessionId || !invocationId || !callbackToken) {
        sendJson(res, 400, { error: "sessionId, invocationId, and callbackToken are required." });
        return true;
      }
      if (!callbacks.validateToken(sessionId, invocationId, callbackToken)) {
        sendJson(res, 401, { error: "Invalid callback token." });
        return true;
      }

      const postOptions = { appendToSession };
      if (durableRecorder) postOptions.durableRecorder = durableRecorder;
      if (memoryCapture) postOptions.memoryCapture = memoryCapture;
      if (memoryService) postOptions.memoryService = memoryService;
      const result = callbacks.postMessage(sessionId, invocationId, content, postOptions);
      if (!result) {
        sendJson(res, 410, { error: "Thread no longer active; message was not delivered." });
        return true;
      }

      sendJson(res, 200, result);
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/callbacks/thread-context") {
      const sessionId = url.searchParams.get("sessionId") || "";
      const invocationId = url.searchParams.get("invocationId") || "";
      const callbackToken = req.headers["x-callback-token"] || "";

      if (!sessionId || !invocationId || !callbackToken) {
        sendJson(res, 400, {
          error: "sessionId, invocationId, and X-Callback-Token are required.",
        });
        return true;
      }
      if (!callbacks.validateToken(sessionId, invocationId, callbackToken)) {
        sendJson(res, 401, { error: "Invalid callback token." });
        return true;
      }

      const session = getSession(sessionsFile, sessionId);
      if (!session) {
        sendJson(res, 404, { error: "Session not found." });
        return true;
      }

      sendJson(res, 200, { messages: session.messages || [] });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/callbacks/list-invocations") {
      const sessionId = url.searchParams.get("sessionId") || "";
      const invocationId = url.searchParams.get("invocationId") || "";
      const callbackToken = req.headers["x-callback-token"] || "";

      if (!sessionId) {
        sendJson(res, 400, { error: "sessionId is required." });
        return true;
      }
      if (
        !validateOptionalCallbackAuth({
          sessionId,
          invocationId,
          callbackToken,
          callbacks,
          sendJson,
          res,
        })
      ) {
        return true;
      }

      const invocations = await recall.listInvocationsWithMeta(sessionId);
      sendJson(res, 200, { invocations });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/callbacks/session-search") {
      const sessionId = url.searchParams.get("sessionId") || "";
      const invocationId = url.searchParams.get("invocationId") || "";
      const callbackToken = req.headers["x-callback-token"] || "";
      const query = url.searchParams.get("query") || "";
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw ? Math.max(1, Math.min(200, parseInt(limitRaw, 10) || 20)) : 20;
      const layers = url.searchParams.get("layers") || "";
      const includeRetired = ["1", "true", "yes"].includes(
        String(url.searchParams.get("includeRetired") || "").toLowerCase()
      );
      const includeThinking = ["1", "true", "yes"].includes(
        String(url.searchParams.get("includeThinking") || "").toLowerCase()
      );

      if (!sessionId) {
        sendJson(res, 400, { error: "sessionId is required." });
        return true;
      }
      if (
        !validateOptionalCallbackAuth({
          sessionId,
          invocationId,
          callbackToken,
          callbacks,
          sendJson,
          res,
        })
      ) {
        return true;
      }

      const scopeRaw = String(url.searchParams.get("scope") || url.searchParams.get("memoryScope") || "")
        .trim()
        .toLowerCase();
      const searchOptions = { limit, includeRetired, includeThinking };
      if (layers) searchOptions.layers = layers;
      if (scopeRaw === "thread" || scopeRaw === "project" || scopeRaw === "all") {
        searchOptions.memoryScope = scopeRaw;
      }

      // Empty/weak query → recency-only (Wave R1). Prefer searchSession when available.
      let body;
      if (typeof recall.searchSession === "function") {
        body = await recall.searchSession(sessionId, query, searchOptions);
      } else {
        const hits = await recall.searchTranscript(sessionId, query || " ", searchOptions);
        body = {
          hits,
          query,
          limit,
          layers: countHitLayers(hits),
          truncated: Array.isArray(hits) && hits.length >= limit,
        };
      }
      sendJson(res, 200, body);
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/callbacks/read-invocation") {
      const sessionId = url.searchParams.get("sessionId") || "";
      const invocationId = url.searchParams.get("invocationId") || "";
      const targetInvocationId = url.searchParams.get("targetInvocationId") || "";
      const callbackToken = req.headers["x-callback-token"] || "";
      const fromRaw = url.searchParams.get("from");
      const limitRaw = url.searchParams.get("limit");
      const from = fromRaw ? Math.max(0, parseInt(fromRaw, 10) || 0) : 0;
      const limit = limitRaw ? Math.max(1, Math.min(2000, parseInt(limitRaw, 10) || 200)) : 200;

      if (!sessionId) {
        sendJson(res, 400, { error: "sessionId is required." });
        return true;
      }
      if (!targetInvocationId) {
        sendJson(res, 400, { error: "targetInvocationId is required." });
        return true;
      }
      if (
        !validateOptionalCallbackAuth({
          sessionId,
          invocationId,
          callbackToken,
          callbacks,
          sendJson,
          res,
        })
      ) {
        return true;
      }

      const result = await recall.readInvocationPage(sessionId, targetInvocationId, {
        from,
        limit,
      });
      if (result.total === 0) {
        sendJson(res, 404, { error: "Invocation not found." });
        return true;
      }

      sendJson(res, 200, { invocationId: targetInvocationId, ...result });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/callbacks/memory-upsert") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return true;
      }

      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const invocationId = typeof body.invocationId === "string" ? body.invocationId : "";
      const callbackToken = typeof body.callbackToken === "string" ? body.callbackToken : "";
      const kind = typeof body.kind === "string" ? body.kind.trim() : "";
      const topic = typeof body.topic === "string" ? body.topic.trim() : "";
      const content = typeof body.content === "string" ? body.content.trim() : "";

      if (!sessionId || !invocationId || !callbackToken) {
        sendJson(res, 400, { error: "sessionId, invocationId, and callbackToken are required." });
        return true;
      }
      if (!callbacks.validateToken(sessionId, invocationId, callbackToken)) {
        sendJson(res, 401, { error: "Invalid callback token." });
        return true;
      }
      if (!memoryService) {
        sendJson(res, 503, {
          error: "Memory service unavailable. SQLite storage is required.",
        });
        return true;
      }
      if (getSession && !getSession(sessionsFile, sessionId)) {
        sendJson(res, 404, { error: "Session not found." });
        return true;
      }
      if (!PRODUCT_KINDS.includes(kind)) {
        sendJson(res, 400, {
          error: `kind must be one of: ${PRODUCT_KINDS.join(", ")}.`,
        });
        return true;
      }
      if (!topic) {
        sendJson(res, 400, { error: "topic is required for memory-upsert." });
        return true;
      }
      if (!content) {
        sendJson(res, 400, { error: "content is required." });
        return true;
      }
      if (content.length > MAX_MEMORY_CONTENT_CHARS) {
        sendJson(res, 400, {
          error: `content exceeds ${MAX_MEMORY_CONTENT_CHARS} characters.`,
        });
        return true;
      }

      const agentId = resolveAgentId(callbacks, sessionId, invocationId);
      try {
        // Prefer linking the active callback invocation; if SQLite has not mirrored
        // it yet (or tests omit the row), still accept the write with metadata only.
        const baseInput = {
          threadId: sessionId,
          kind,
          topic,
          content,
          supersessionKey:
            typeof body.supersessionKey === "string" ? body.supersessionKey : undefined,
          createdBy: agentId,
          writeChannel: "agent",
          metadata: {
            ...(body.metadata && typeof body.metadata === "object" ? body.metadata : {}),
            source: "callback:memory-upsert",
            callbackInvocationId: invocationId,
          },
        };
        let outcome;
        try {
          outcome = memoryService.createProduct({
            ...baseInput,
            sourceInvocationId: invocationId,
          });
        } catch (error) {
          if (!/Source invocation .* does not exist/i.test(String(error.message || ""))) {
            throw error;
          }
          outcome = memoryService.createProduct(baseInput);
        }

        try {
          appendMemoryCapturedEvent(
            eventStore,
            sessionId,
            invocationId,
            outcome.memory,
            outcome.created
          );
        } catch (error) {
          logger.error?.(`[memory-upsert] event append failed: ${error.message}`);
        }

        const payload = {
          action: "upsert",
          sessionId,
          created: outcome.created,
          topic: outcome.topic,
          supersessionKey: outcome.supersessionKey,
          superseded: outcome.superseded,
          memory: {
            id: outcome.memory.id,
            kind: outcome.memory.kind,
            status: outcome.memory.status,
            content: outcome.memory.content,
            topic: outcome.topic,
            supersessionKey: outcome.supersessionKey,
            createdBy: outcome.memory.createdBy,
            createdAt: outcome.memory.createdAt,
          },
        };
        broadcastMemoryEvent(callbacks, sessionId, payload);
        const liveStats = bumpThreadWriteStat(callbacks, sessionId, "upsertCallback", 1);
        const writeMetrics = buildMemoryWriteMetrics({
          source: "callback",
          threadId: sessionId,
          invocationId,
          agent: agentId,
          stats: liveStats,
        });
        logMemoryWriteMetrics(writeMetrics, logger);
        if (typeof callbacks.sendSse === "function") {
          const thread =
            typeof callbacks.getThread === "function" ? callbacks.getThread(sessionId) : null;
          if (thread?.res) callbacks.sendSse(thread.res, "memory-metrics", writeMetrics);
        }

        sendJson(res, 200, {
          ok: true,
          created: outcome.created,
          topic: outcome.topic,
          supersessionKey: outcome.supersessionKey,
          memory: outcome.memory,
          superseded: outcome.superseded,
        });
      } catch (error) {
        logger.error?.(`[memory-upsert] failed: ${error.message}`);
        bumpThreadWriteStat(callbacks, sessionId, "errors", 1);
        sendJson(res, 400, { error: error.message });
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/callbacks/memory-invalidate") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return true;
      }

      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const invocationId = typeof body.invocationId === "string" ? body.invocationId : "";
      const callbackToken = typeof body.callbackToken === "string" ? body.callbackToken : "";
      const memoryId = typeof body.id === "string" ? body.id.trim() : "";
      const reason = typeof body.reason === "string" ? body.reason : "";

      if (!sessionId || !invocationId || !callbackToken) {
        sendJson(res, 400, { error: "sessionId, invocationId, and callbackToken are required." });
        return true;
      }
      if (!callbacks.validateToken(sessionId, invocationId, callbackToken)) {
        sendJson(res, 401, { error: "Invalid callback token." });
        return true;
      }
      if (!memoryService) {
        sendJson(res, 503, {
          error: "Memory service unavailable. SQLite storage is required.",
        });
        return true;
      }
      if (!memoryId) {
        sendJson(res, 400, { error: "id is required." });
        return true;
      }
      if (getSession && !getSession(sessionsFile, sessionId)) {
        sendJson(res, 404, { error: "Session not found." });
        return true;
      }

      const existing = memoryService.get(memoryId);
      if (!existing || existing.threadId !== sessionId) {
        sendJson(res, 404, { error: "Memory not found." });
        return true;
      }

      const agentId = resolveAgentId(callbacks, sessionId, invocationId);
      try {
        const memory = memoryService.invalidate(memoryId, {
          invalidatedBy: agentId,
          reason,
        });
        const payload = {
          action: "invalidate",
          sessionId,
          memory: {
            id: memory.id,
            kind: memory.kind,
            status: memory.status,
            content: memory.content,
            topic: memory.topic,
            supersessionKey: memory.supersessionKey,
            createdBy: memory.createdBy,
            createdAt: memory.createdAt,
          },
        };
        broadcastMemoryEvent(callbacks, sessionId, payload);
        const liveStats = bumpThreadWriteStat(callbacks, sessionId, "invalidateCallback", 1);
        const writeMetrics = buildMemoryWriteMetrics({
          source: "callback",
          threadId: sessionId,
          invocationId,
          agent: agentId,
          stats: liveStats,
        });
        logMemoryWriteMetrics(writeMetrics, logger);
        if (typeof callbacks.sendSse === "function") {
          const thread =
            typeof callbacks.getThread === "function" ? callbacks.getThread(sessionId) : null;
          if (thread?.res) callbacks.sendSse(thread.res, "memory-metrics", writeMetrics);
        }
        sendJson(res, 200, { ok: true, memory });
      } catch (error) {
        logger.error?.(`[memory-invalidate] failed: ${error.message}`);
        bumpThreadWriteStat(callbacks, sessionId, "errors", 1);
        sendJson(res, 400, { error: error.message });
      }
      return true;
    }

    return false;
  };
}

module.exports = {
  createCallbackRoutes,
  resolveAgentId,
  broadcastMemoryEvent,
};

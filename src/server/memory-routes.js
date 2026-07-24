const { isValidOpaqueId } = require("./id-policy");
const { PRODUCT_KINDS } = require("../storage/memory-keys");

/**
 * L3 Memory product API.
 *
 * GET  /api/memories?sessionId=&kind=&status=&includeRetired=
 * POST /api/memories
 * GET  /api/memories/:id
 * POST /api/memories/:id/confirm
 * POST /api/memories/:id/invalidate
 */
function createMemoryRoutes({
  memoryService = null,
  getSession,
  sessionsFile,
  sendJson,
  readJsonBody,
  eventStore = null,
  logger = console,
} = {}) {
  return async function handleMemoryRoutes(req, res, url) {
    if (!url.pathname.startsWith("/api/memories")) return false;

    if (!memoryService) {
      sendJson(res, 503, {
        error: "Memory service unavailable. Enable SQLite storage (dual or sqlite mode).",
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/memories") {
      const sessionId = url.searchParams.get("sessionId") || url.searchParams.get("threadId");
      if (!sessionId || !isValidOpaqueId(sessionId)) {
        sendJson(res, 400, { error: "sessionId is required." });
        return true;
      }
      if (getSession && !getSession(sessionsFile, sessionId)) {
        sendJson(res, 404, { error: "Session not found." });
        return true;
      }

      const includeRetiredParam = url.searchParams.get("includeRetired");
      const includeRetired =
        includeRetiredParam === null || includeRetiredParam === ""
          ? true
          : includeRetiredParam === "1" || includeRetiredParam === "true";

      try {
        const memories = memoryService.list(sessionId, {
          kinds: url.searchParams.get("kind") || url.searchParams.get("kinds"),
          statuses: url.searchParams.get("status") || url.searchParams.get("statuses"),
          includeRetired,
          limit: url.searchParams.get("limit"),
        });
        sendJson(res, 200, {
          sessionId,
          memories,
          kinds: PRODUCT_KINDS,
          counts: countBy(memories, (item) => item.status),
        });
      } catch (error) {
        logger.error?.(`[memory-api] list failed: ${error.message}`);
        sendJson(res, 400, { error: error.message });
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/memories") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body." });
        return true;
      }

      const sessionId = body.sessionId || body.threadId;
      if (!sessionId || !isValidOpaqueId(sessionId)) {
        sendJson(res, 400, { error: "sessionId is required." });
        return true;
      }
      if (getSession && !getSession(sessionsFile, sessionId)) {
        sendJson(res, 404, { error: "Session not found." });
        return true;
      }

      try {
        const outcome = memoryService.createProduct({
          threadId: sessionId,
          kind: body.kind,
          content: body.content,
          topic: body.topic,
          supersessionKey: body.supersessionKey,
          sourceMessageId: body.sourceMessageId,
          sourceInvocationId: body.sourceInvocationId,
          createdBy: body.createdBy || "user",
          writeChannel: "user",
          scope: body.scope,
          anchors: body.anchors,
          metadata: body.metadata,
        });

        // Best-effort L1 evidence event when an invocation is provided.
        if (
          eventStore &&
          outcome.created &&
          typeof body.sourceInvocationId === "string" &&
          body.sourceInvocationId
        ) {
          try {
            eventStore.append({
              threadId: sessionId,
              invocationId: body.sourceInvocationId,
              kind: "memory-captured",
              payload: {
                id: outcome.memory.id,
                threadId: sessionId,
                kind: outcome.memory.kind,
                status: outcome.memory.status,
                content: outcome.memory.content,
                captureKey: outcome.memory.captureKey,
                supersessionKey: outcome.memory.supersessionKey,
                createdBy: outcome.memory.createdBy,
                createdAt: outcome.memory.createdAt,
                persisted: true,
                created: true,
              },
            });
          } catch (error) {
            logger.error?.(`[memory-api] event append failed: ${error.message}`);
          }
        }

        sendJson(res, outcome.created ? 201 : 200, {
          memory: outcome.memory,
          created: outcome.created,
          superseded: outcome.superseded,
          topic: outcome.topic,
          supersessionKey: outcome.supersessionKey,
        });
      } catch (error) {
        logger.error?.(`[memory-api] create failed: ${error.message}`);
        sendJson(res, 400, { error: error.message });
      }
      return true;
    }

    const detailMatch = url.pathname.match(/^\/api\/memories\/([a-zA-Z0-9_-]+)$/);
    if (detailMatch && req.method === "GET") {
      const memory = memoryService.get(detailMatch[1]);
      if (!memory) {
        sendJson(res, 404, { error: "Memory not found." });
        return true;
      }
      sendJson(res, 200, { memory });
      return true;
    }

    const confirmMatch = url.pathname.match(/^\/api\/memories\/([a-zA-Z0-9_-]+)\/confirm$/);
    if (confirmMatch && req.method === "POST") {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body." });
        return true;
      }
      try {
        const memory = memoryService.confirm(confirmMatch[1], {
          confirmedBy: body.confirmedBy || "user",
          confirmationSource: body.confirmationSource || "ui:memory-panel",
          confirmedAt: body.confirmedAt,
        });
        if (!memory) {
          sendJson(res, 404, { error: "Memory not found." });
          return true;
        }
        sendJson(res, 200, { memory });
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return true;
    }

    const invalidateMatch = url.pathname.match(
      /^\/api\/memories\/([a-zA-Z0-9_-]+)\/invalidate$/
    );
    if (invalidateMatch && req.method === "POST") {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body." });
        return true;
      }
      try {
        const memory = memoryService.invalidate(invalidateMatch[1], {
          invalidatedBy: body.invalidatedBy || "user",
          reason: body.reason || body.invalidationReason || "",
          invalidatedAt: body.invalidatedAt,
        });
        if (!memory) {
          sendJson(res, 404, { error: "Memory not found." });
          return true;
        }
        sendJson(res, 200, { memory });
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return true;
    }

    return false;
  };
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

module.exports = { createMemoryRoutes };

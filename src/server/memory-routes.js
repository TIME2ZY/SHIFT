const { isValidOpaqueId } = require("./id-policy");
const { PRODUCT_KINDS } = require("../storage/memory-keys");

/**
 * L3 Memory product API + suggestion queue (PR-3).
 *
 * GET  /api/memories?sessionId=&kind=&status=&includeRetired=
 * POST /api/memories
 * GET  /api/memories/:id
 * POST /api/memories/:id/confirm
 * POST /api/memories/:id/invalidate
 *
 * GET  /api/memories/suggestions?sessionId=&status=&includeProject=
 * POST /api/memories/suggestions
 * GET  /api/memories/suggestions/:id
 * POST /api/memories/suggestions/:id/accept
 * POST /api/memories/suggestions/:id/reject
 */
function createMemoryRoutes({
  memoryService = null,
  suggestionService = null,
  storage = null,
  getSession,
  sessionsFile,
  sendJson,
  readJsonBody,
  eventStore = null,
  logger = console,
} = {}) {
  return async function handleMemoryRoutes(req, res, url) {
    if (!url.pathname.startsWith("/api/memories")) return false;

    // Suggestion routes are served even when listing product memories is available.
    if (url.pathname.startsWith("/api/memories/suggestions")) {
      return handleSuggestionRoutes(req, res, url, {
        suggestionService,
        getSession,
        sessionsFile,
        sendJson,
        readJsonBody,
        logger,
      });
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/memories/project-evidence/reindex"
    ) {
      if (!storage?.reindexProjectEvidence) {
        sendJson(res, 503, { error: "Project evidence indexer unavailable." });
        return true;
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body." });
        return true;
      }
      const sessionId = body.sessionId || body.threadId || url.searchParams.get("sessionId");
      if (!sessionId || !isValidOpaqueId(sessionId)) {
        sendJson(res, 400, { error: "sessionId is required." });
        return true;
      }
      if (getSession && !getSession(sessionsFile, sessionId)) {
        sendJson(res, 404, { error: "Session not found." });
        return true;
      }
      try {
        const result = storage.reindexProjectEvidence(sessionId, body.options || {});
        sendJson(res, 200, { sessionId, result });
      } catch (error) {
        logger.error?.(`[memory-api] project evidence reindex failed: ${error.message}`);
        sendJson(res, 400, { error: error.message });
      }
      return true;
    }

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
        const digest = storage?.digests?.get?.(sessionId) || null;
        const pendingSuggestions =
          suggestionService?.list?.(sessionId, {
            status: "pending",
            includeProject: true,
            limit: 20,
          }) || [];
        const handoffs = memoryService.list(sessionId, {
          kinds: "handoff",
          includeRetired: false,
          limit: 10,
        });
        sendJson(res, 200, {
          sessionId,
          memories,
          kinds: PRODUCT_KINDS,
          counts: countBy(memories, (item) => item.status),
          context: {
            digest,
            handoffs,
            pendingSuggestions,
          },
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

async function handleSuggestionRoutes(
  req,
  res,
  url,
  { suggestionService, getSession, sessionsFile, sendJson, readJsonBody, logger }
) {
  if (!suggestionService) {
    sendJson(res, 503, {
      error: "Suggestion service unavailable. Enable SQLite storage (dual or sqlite mode).",
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/memories/suggestions") {
    const sessionId = url.searchParams.get("sessionId") || url.searchParams.get("threadId");
    if (!sessionId || !isValidOpaqueId(sessionId)) {
      sendJson(res, 400, { error: "sessionId is required." });
      return true;
    }
    if (getSession && !getSession(sessionsFile, sessionId)) {
      sendJson(res, 404, { error: "Session not found." });
      return true;
    }
    try {
      const includeProject =
        url.searchParams.get("includeProject") === "1" ||
        url.searchParams.get("includeProject") === "true" ||
        url.searchParams.get("includeProject") === null ||
        url.searchParams.get("includeProject") === "";
      const suggestions = suggestionService.list(sessionId, {
        status: url.searchParams.get("status") || undefined,
        includeProject,
        scope: url.searchParams.get("scope") || undefined,
        limit: url.searchParams.get("limit"),
      });
      sendJson(res, 200, {
        sessionId,
        suggestions,
        counts: countBy(suggestions, (item) => item.status),
      });
    } catch (error) {
      logger.error?.(`[memory-api] list suggestions failed: ${error.message}`);
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/memories/suggestions") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body." });
      return true;
    }
    const sessionId = body.sessionId || body.threadId || body.originThreadId;
    if (!sessionId || !isValidOpaqueId(sessionId)) {
      sendJson(res, 400, { error: "sessionId is required." });
      return true;
    }
    if (getSession && !getSession(sessionsFile, sessionId)) {
      sendJson(res, 404, { error: "Session not found." });
      return true;
    }
    try {
      const suggestion = suggestionService.create({
        originThreadId: sessionId,
        proposedKind: body.kind || body.proposedKind,
        proposedScope: body.scope || body.proposedScope,
        topic: body.topic,
        summary: body.summary,
        content: body.content,
        confidence: body.confidence,
        anchors: body.anchors,
        extractorVersion: body.extractorVersion || "api",
        createdBy: body.createdBy,
        writeChannel: body.writeChannel || "extractor",
        metadata: body.metadata,
      });
      sendJson(res, 201, { suggestion });
    } catch (error) {
      logger.error?.(`[memory-api] create suggestion failed: ${error.message}`);
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  const detailMatch = url.pathname.match(/^\/api\/memories\/suggestions\/([a-zA-Z0-9_-]+)$/);
  if (detailMatch && req.method === "GET") {
    const suggestion = suggestionService.get(detailMatch[1]);
    if (!suggestion) {
      sendJson(res, 404, { error: "Suggestion not found." });
      return true;
    }
    sendJson(res, 200, { suggestion });
    return true;
  }

  const acceptMatch = url.pathname.match(
    /^\/api\/memories\/suggestions\/([a-zA-Z0-9_-]+)\/accept$/
  );
  if (acceptMatch && req.method === "POST") {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body." });
      return true;
    }
    try {
      const outcome = suggestionService.accept(acceptMatch[1], {
        reviewedBy: body.reviewedBy || body.acceptedBy || "user",
        reviewChannel: "user",
        writeChannel: "user",
        confirmationSource: body.confirmationSource || "ui:suggestion-accept",
        reason: body.reason,
      });
      if (!outcome) {
        sendJson(res, 404, { error: "Suggestion not found." });
        return true;
      }
      sendJson(res, 200, outcome);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  const rejectMatch = url.pathname.match(
    /^\/api\/memories\/suggestions\/([a-zA-Z0-9_-]+)\/reject$/
  );
  if (rejectMatch && req.method === "POST") {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body." });
      return true;
    }
    try {
      const suggestion = suggestionService.reject(rejectMatch[1], {
        reviewedBy: body.reviewedBy || body.rejectedBy || "user",
        reviewChannel: "user",
        writeChannel: "user",
        reason: body.reason,
      });
      if (!suggestion) {
        sendJson(res, 404, { error: "Suggestion not found." });
        return true;
      }
      sendJson(res, 200, { suggestion });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  return false;
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

const { isValidOpaqueId } = require("./id-policy");
const { PRODUCT_KINDS } = require("../storage/memory-keys");

/**
 * Read-only product Memory API.
 *
 * Product writes are accepted only through the invocation-bound memory_write
 * tool/callback. Corrections are new writes to the same scopeKey + topic slot.
 */
function createMemoryRoutes({
  memoryService = null,
  storage = null,
  getSession,
  sendJson,
  readJsonBody,
  logger = console,
} = {}) {
  return async function handleMemoryRoutes(req, res, url) {
    if (!url.pathname.startsWith("/api/memories")) return false;

    if (req.method === "POST" && url.pathname === "/api/memories/project-evidence/reindex") {
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
      if (getSession && !getSession(sessionId)) {
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
        error: "Memory service unavailable. SQLite storage is required.",
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/memories") {
      const sessionId = url.searchParams.get("sessionId") || url.searchParams.get("threadId");
      if (!sessionId || !isValidOpaqueId(sessionId)) {
        sendJson(res, 400, { error: "sessionId is required." });
        return true;
      }
      if (getSession && !getSession(sessionId)) {
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

    const detailMatch = url.pathname.match(/^\/api\/memories\/([a-zA-Z0-9_-]+)$/);
    if (detailMatch && req.method === "GET") {
      const memory = memoryService.get(detailMatch[1]);
      if (!memory || !PRODUCT_KINDS.includes(memory.kind)) {
        sendJson(res, 404, { error: "Memory not found." });
        return true;
      }
      sendJson(res, 200, { memory });
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

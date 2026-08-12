function createStorageRoutes({
  storageContext,
  sendJson,
  readJsonBody,
  defaultRetentionDays = 7,
} = {}) {
  if (!storageContext || !sendJson || !readJsonBody) {
    throw new Error("Storage routes require storageContext, sendJson, and readJsonBody.");
  }

  function healthPayload() {
    let epoch = null;
    try {
      epoch = storageContext.storage?.metadata?.getCurrent?.() || null;
    } catch {
      epoch = null;
    }
    return {
      storage: {
        mode: storageContext.mode,
        auditTranscript: Boolean(storageContext.auditTranscript),
        epoch,
        outbox: storageContext.outboxHealth?.() || {
          state: "unavailable",
          pending: 0,
          oldestPendingAt: null,
          lastError: null,
        },
        observability: storageContext.observabilityHealth?.() || {
          state: "unavailable",
          authoritativeViolations: null,
          checks: null,
        },
      },
    };
  }

  return async function handleStorageRoutes(req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/storage/health") {
      sendJson(res, 200, healthPayload());
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/storage/observability/metrics") {
      try {
        const metrics = storageContext.observabilityMetrics?.({
          from: url.searchParams.get("from"),
          to: url.searchParams.get("to"),
        });
        if (!metrics) {
          sendJson(res, 503, { error: "Observability metrics are unavailable." });
          return true;
        }
        sendJson(res, 200, { metrics });
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return true;
    }

    const traceMatch = url.pathname.match(/^\/api\/storage\/observability\/traces\/([^/]+)$/);
    if (req.method === "GET" && traceMatch) {
      let traceId;
      try {
        traceId = decodeURIComponent(traceMatch[1]);
      } catch {
        sendJson(res, 400, { error: "traceId is invalid." });
        return true;
      }
      const threadId = url.searchParams.get("threadId");
      if (!threadId) {
        sendJson(res, 400, { error: "threadId is required." });
        return true;
      }
      const trace = storageContext.inspectTrace?.(traceId) || null;
      if (!trace || trace.threadId !== threadId) {
        sendJson(res, 404, { error: "Trace not found for this Thread." });
        return true;
      }
      sendJson(res, 200, { trace });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/storage/outbox/cleanup") {
      const body = await readJsonBody(req);
      const retentionDays = Number(body.retentionDays ?? defaultRetentionDays);
      const limit = Number(body.limit ?? 1000);
      if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
        sendJson(res, 400, { error: "retentionDays must be an integer from 1 to 365." });
        return true;
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
        sendJson(res, 400, { error: "limit must be an integer from 1 to 10000." });
        return true;
      }
      const result = storageContext.cleanupDeliveredOutbox?.({ retentionDays, limit }) || {
        available: false,
        deleted: 0,
      };
      if (!result.available) {
        sendJson(res, 503, { error: "SQLite outbox is unavailable." });
        return true;
      }
      sendJson(res, 200, { cleanup: result, ...healthPayload() });
      return true;
    }

    return false;
  };
}

module.exports = { createStorageRoutes };

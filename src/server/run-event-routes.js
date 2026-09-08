"use strict";

const { ENV } = require("../shared/brand");
const { assertValidOpaqueId } = require("./id-policy");
const { toSseFrame } = require("./chat-runtime");

const REPLAY_PAGE_SIZE = 500;

function parseCursor(url, req) {
  const header = req.headers["last-event-id"];
  const query = url.searchParams.get("after");
  const raw = query != null && query !== "" ? query : header;
  const cursor = Number(raw);
  return Number.isFinite(cursor) && cursor >= 0 ? cursor : 0;
}

function writeSse(res, eventName, data, id) {
  if (!res || res.destroyed || res.writableEnded) return;
  if (id != null && id !== "") res.write(`id: ${id}\n`);
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeFrame(res, event) {
  if (!res || res.destroyed || res.writableEnded) return;
  const frame = toSseFrame(event);
  if (!frame) return;
  writeSse(res, frame.event, frame.data, frame.id);
}

function replayEventsAfter(storage, sessionId, after, onEvent) {
  if (typeof storage?.invocations?.listEventsAfter !== "function") return after;
  let cursor = after;
  for (;;) {
    const page = storage.invocations.listEventsAfter(sessionId, cursor, REPLAY_PAGE_SIZE);
    if (!page.length) break;
    for (const event of page) {
      onEvent(event);
      if (typeof event.id === "number") cursor = event.id;
    }
    if (page.length < REPLAY_PAGE_SIZE) break;
  }
  return cursor;
}

function createRunEventRoutes({ runtime, storage, getSession, sendJson, readJsonBody }) {
  if (!runtime) throw new TypeError("runtime is required");

  return async function handleRunEventRoutes(req, res, url) {
    const runMatch = url.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)\/runs$/);
    if (runMatch && req.method === "POST") {
      const sessionId = runMatch[1];
      try {
        assertValidOpaqueId(sessionId, "sessionId");
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return true;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return true;
      }
      const protocol = req.headers["x-forwarded-proto"] || "http";
      const host = req.headers.host || "127.0.0.1";
      const result = await runtime.startRun({
        body: { ...body, sessionId },
        apiUrl: process.env[ENV.API_URL] || `${protocol}://${host}`,
        host,
      });
      sendJson(res, result.status, result.json);
      return true;
    }

    const stopMatch = url.pathname.match(
      /^\/api\/sessions\/([a-zA-Z0-9_-]+)\/runs\/([a-zA-Z0-9_-]+)\/stop$/
    );
    if (stopMatch && req.method === "POST") {
      const sessionId = stopMatch[1];
      const traceId = stopMatch[2];
      if (!getSession(sessionId)) {
        sendJson(res, 404, { error: "Session not found or its Project is archived." });
        return true;
      }
      const outcome = runtime.stopRun(sessionId, traceId);
      sendJson(res, 200, { ...outcome, sessionId, traceId });
      return true;
    }

    const eventsMatch = url.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)\/events$/);
    if (eventsMatch && req.method === "GET") {
      const sessionId = eventsMatch[1];
      if (!getSession(sessionId)) {
        sendJson(res, 404, { error: "Session not found or its Project is archived." });
        return true;
      }
      const after = parseCursor(url, req);
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });

      const buffered = [];
      let replaying = true;
      const unsubscribe = runtime.subscribe(sessionId, {
        onEvent(event) {
          if (res.destroyed || res.writableEnded) return;
          if (replaying) {
            buffered.push(event);
            return;
          }
          writeFrame(res, event);
        },
        close() {
          unsubscribe();
          if (!res.destroyed && !res.writableEnded) res.end();
        },
      });
      res.once("close", () => {
        unsubscribe();
      });

      const snapshot =
        typeof storage?.executions?.runSnapshot === "function"
          ? storage.executions.runSnapshot(sessionId)
          : { sessionId, lastEventId: after, runStatus: "idle", traceId: null };
      writeSse(res, "snapshot", snapshot);

      const lastId = replayEventsAfter(storage, sessionId, after, (event) => {
        writeFrame(res, event);
      });
      replaying = false;
      for (const event of buffered) {
        if (typeof event.id !== "number" || event.id > lastId) writeFrame(res, event);
      }
      return true;
    }

    return false;
  };
}

module.exports = { createRunEventRoutes, parseCursor, REPLAY_PAGE_SIZE };

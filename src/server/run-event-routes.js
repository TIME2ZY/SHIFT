"use strict";

const { assertValidOpaqueId } = require("../shared/id-policy");
const { toSseFrame } = require("./chat-runtime");
const { setImmediate: yieldToIo } = require("node:timers/promises");

const REPLAY_PAGE_SIZE = 500;

function parseCursor(url, req) {
  const header = req.headers["last-event-id"];
  const query = url.searchParams.get("after");
  const raw = query != null && query !== "" ? query : header;
  const cursor = Number(raw);
  return Number.isFinite(cursor) && cursor >= 0 ? cursor : 0;
}

async function writeSse(res, eventName, data, id) {
  if (!res || res.destroyed || res.writableEnded) return;
  const prefix = id != null && id !== "" ? `id: ${id}\n` : "";
  if (res.write(`${prefix}event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`)) return;
  await new Promise((resolve, reject) => {
    function cleanup() {
      res.off("drain", drained);
      res.off("close", drained);
      res.off("error", failed);
    }
    function drained() {
      cleanup();
      resolve();
    }
    function failed(error) {
      cleanup();
      reject(error);
    }
    res.once("drain", drained);
    res.once("close", drained);
    res.once("error", failed);
  });
}

function writeFrame(res, event) {
  if (!res || res.destroyed || res.writableEnded) return;
  const frame = toSseFrame(event);
  if (!frame) return;
  return writeSse(res, frame.event, frame.data, frame.id);
}

async function replayEventsAfter(storage, sessionId, after, res) {
  if (typeof storage?.invocations?.listEventsAfter !== "function") return after;
  let cursor = after;
  for (;;) {
    if (res.destroyed || res.writableEnded) break;
    const page = storage.invocations.listEventsAfter(sessionId, cursor, REPLAY_PAGE_SIZE);
    if (!page.length) break;
    for (const event of page) {
      if (res.destroyed || res.writableEnded) return cursor;
      await writeFrame(res, event);
      if (typeof event.id === "number") cursor = event.id;
    }
    if (page.length < REPLAY_PAGE_SIZE) break;
    await yieldToIo();
  }
  return cursor;
}

function createRunEventRoutes({
  runtime,
  storage,
  getSession,
  sendJson,
  readJsonBody,
  prepareRun,
}) {
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
      try {
        if (!getSession(sessionId)) {
          sendJson(res, 404, { error: "Session not found or its Project is archived." });
        } else if (body.projectDir !== undefined) {
          sendJson(res, 400, {
            error: "projectDir is bound by the Session Project and cannot be changed.",
          });
        } else if (body.useWorktree || body.duty || body.internalPurpose) {
          sendJson(res, 409, {
            error: "运行入口只用于整理草稿；执行必须提交委托。",
            code: "DELEGATION_SUBMISSION_REQUIRED",
          });
        } else {
          const result = await prepareRun(sessionId, {
            prompt: body.prompt,
            clientTurnId: body.clientTurnId,
            agent: body.agent,
          });
          sendJson(res, 202, result);
        }
      } catch (error) {
        sendJson(res, error.statusCode || 400, { error: error.message, code: error.code });
      }
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
      let flushing = false;
      let lastId = after;
      async function flushBuffered() {
        if (replaying || flushing) return;
        flushing = true;
        try {
          while (buffered.length && !res.destroyed && !res.writableEnded) {
            const page = buffered.splice(0, REPLAY_PAGE_SIZE);
            for (const event of page) {
              if (res.destroyed || res.writableEnded) return;
              if (typeof event.id === "number" && event.id <= lastId) continue;
              await writeFrame(res, event);
              if (typeof event.id === "number") lastId = event.id;
            }
            await yieldToIo();
          }
        } catch (error) {
          // Closing only the observer makes the client resume from its applied cursor.
          res.destroy(error);
        } finally {
          flushing = false;
        }
      }
      const unsubscribe = runtime.subscribe(sessionId, {
        onEvent(event) {
          if (res.destroyed || res.writableEnded) return;
          if (buffered.length >= REPLAY_PAGE_SIZE) {
            // Bound live backlog during replay/drain; durable events remain replayable.
            res.destroy();
            return;
          }
          buffered.push(event);
          void flushBuffered();
        },
        close() {
          unsubscribe();
          if (!res.destroyed && !res.writableEnded) res.end();
        },
      });
      res.once("close", () => {
        unsubscribe();
        buffered.length = 0;
      });

      const snapshot =
        typeof storage?.executions?.runSnapshot === "function"
          ? storage.executions.runSnapshot(sessionId)
          : { sessionId, lastEventId: after, runStatus: "idle", traceId: null };
      try {
        await writeSse(res, "snapshot", snapshot);
        lastId = await replayEventsAfter(storage, sessionId, after, res);
        replaying = false;
        await flushBuffered();
      } catch (error) {
        res.destroy(error);
      }
      return true;
    }

    return false;
  };
}

module.exports = { createRunEventRoutes, parseCursor, REPLAY_PAGE_SIZE };

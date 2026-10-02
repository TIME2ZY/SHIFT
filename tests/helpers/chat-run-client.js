"use strict";

function hasTerminal(text, traceId, until = "done") {
  return text
    .split("\n\n")
    .slice(0, -1)
    .some((frame) => {
      const name = frame.match(/^event: (.+)$/m)?.[1];
      const raw = frame.match(/^data: (.+)$/m)?.[1];
      if (!raw) return false;
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return false;
      }
      if (traceId && data.traceId !== traceId) return false;
      return [until, "run.aborted", "done", "error"].includes(name) || data.type === "run.failed";
    });
}

function mergeHeaders(base, extra) {
  const headers = new Headers(base || {});
  const extraHeaders = extra instanceof Headers ? extra : new Headers(extra || {});
  for (const [key, value] of extraHeaders.entries()) headers.set(key, value);
  return headers;
}

function request(init, url, options) {
  const doFetch = init.fetch || fetch;
  return doFetch(url, {
    ...options,
    headers: mergeHeaders(options.headers, init.headers),
    signal: options.signal || init.signal,
  });
}

function combineSignal(init, timeoutMs = 30_000) {
  const signals = [];
  if (init?.signal) signals.push(init.signal);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0 && typeof AbortSignal.timeout === "function") {
    signals.push(AbortSignal.timeout(timeoutMs));
  }
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  return signals[0];
}

async function closeTestServer(server, timeoutMs = 8000) {
  if (!server) return;
  const closing =
    typeof server.shutdown === "function"
      ? server.shutdown()
      : Promise.all([
          new Promise((resolve) => server.close(resolve)),
          Promise.resolve(server.closeStorageContext?.()),
        ]);
  await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}

const testStorageByOrigin = new Map();
function registerTaskTestStorage(baseUrl, storage) {
  testStorageByOrigin.set(new URL(baseUrl).origin, storage);
}
async function startSessionRun(baseUrl, body, init = {}) {
  const storage = testStorageByOrigin.get(new URL(baseUrl).origin);
  let route = `${baseUrl}/api/sessions/${encodeURIComponent(body.sessionId)}/runs`;
  let payload = body;
  // Lifecycle fixtures bind their existing observation Thread to a real independent draft.
  // Production never exposes an initialize-by-thread write API.
  if (
    storage?.threads.get(body.sessionId) &&
    !body.useWorktree &&
    !body.duty &&
    !body.internalPurpose
  ) {
    let task = storage.tasks.list().find((entry) => entry.preparationThreadId === body.sessionId);
    if (!task) {
      task = storage.tasks.create({ projectKey: storage.threads.get(body.sessionId).projectKey });
      task = storage.tasks.bindPreparation(task.id, body.sessionId);
    }
    route = `${baseUrl}/api/tasks/${task.id}/prepare`;
    payload = { prompt: body.prompt, clientTurnId: body.clientTurnId };
    for (let n = 0; n < 100; n++) {
      const status = await request(init, `${baseUrl}/api/tasks/${task.id}`, {}).then((response) =>
        response.json()
      );
      if (!status.recoveryBlocked && !status.preparingTaskId) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return request(init, route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: combineSignal(init, init.timeoutMs),
  });
}

async function stopSessionRun(baseUrl, sessionId, traceId, init = {}) {
  return request(
    init,
    `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(traceId)}/stop`,
    {
      method: "POST",
      headers: { ...(init.headers || {}) },
      signal: init.signal,
    }
  );
}

async function collectSessionEvents(baseUrl, sessionId, init = {}) {
  const until = init.untilEvent || "done";
  const response = await request(
    init,
    `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/events`,
    {
      headers: {
        accept: "text/event-stream",
        ...(init.after ? { "Last-Event-ID": String(init.after) } : {}),
        ...(init.headers || {}),
      },
      signal: combineSignal(init, init.timeoutMs),
    }
  );
  if (!response.ok || !response.body) {
    return { response, text: await response.text() };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (hasTerminal(text, init.traceId, until)) {
      try {
        await reader.cancel();
      } catch {
        // observer disconnect must not fail the helper
      }
      break;
    }
  }
  return { response, text };
}

function terminateOnDone(stream, traceId) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
      buffer += decoder.decode(value, { stream: true });
      if (hasTerminal(buffer, traceId)) {
        try {
          await reader.cancel();
        } catch {
          // observer disconnect
        }
        controller.close();
      }
    },
    cancel() {
      return reader.cancel();
    },
  });
}

async function startAndCollect(baseUrl, body, init = {}) {
  const start = await startSessionRun(baseUrl, body, init);
  if (start.status !== 202) return start;
  const startJson = await start.json();
  const events = await request(
    init,
    `${baseUrl}/api/sessions/${encodeURIComponent(body.sessionId)}/events`,
    {
      headers: { accept: "text/event-stream" },
      signal: combineSignal(init, init.timeoutMs),
    }
  );
  if (!events.ok || !events.body) return events;
  const response = new Response(terminateOnDone(events.body, startJson.traceId), {
    status: 200,
    headers: events.headers,
  });
  response.startStatus = start.status;
  response.traceId = startJson.traceId;
  return response;
}

module.exports = {
  registerTaskTestStorage,
  startSessionRun,
  stopSessionRun,
  collectSessionEvents,
  startAndCollect,
  closeTestServer,
};

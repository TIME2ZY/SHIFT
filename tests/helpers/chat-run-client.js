"use strict";

function hasTerminal(text, traceId, until = "done") {
  const haystack = traceId ? text.slice(text.lastIndexOf(traceId)) : text;
  if (traceId && !text.includes(traceId)) return false;
  return (
    haystack.includes(`event: ${until}`) ||
    haystack.includes("event: run.aborted") ||
    haystack.includes("event: done") ||
    haystack.includes("event: error") ||
    haystack.includes('"type":"run.failed"')
  );
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

async function startSessionRun(baseUrl, body, init = {}) {
  return request(init, `${baseUrl}/api/sessions/${encodeURIComponent(body.sessionId)}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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
  startSessionRun,
  stopSessionRun,
  collectSessionEvents,
  startAndCollect,
  closeTestServer,
};

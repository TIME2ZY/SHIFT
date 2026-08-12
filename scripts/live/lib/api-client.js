/**
 * HTTP client for SHIFT UI API (real server, real UI token).
 */

const { UI_TOKEN_HEADER_CANONICAL } = require("../../../src/shared/brand");
const { parseSse, extractAssistantText, summarizeEvents } = require("./sse");

function createApiClient({ baseUrl, uiToken }) {
  const root = String(baseUrl || "").replace(/\/$/, "");

  async function apiFetch(path, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set(UI_TOKEN_HEADER_CANONICAL, uiToken);
    if (init.method && init.method !== "GET" && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const url = path.startsWith("http") ? path : `${root}${path}`;
    const response = await fetch(url, { ...init, headers });
    return response;
  }

  async function getJson(path) {
    const response = await apiFetch(path);
    const body = await response.json().catch(() => ({}));
    return { status: response.status, ok: response.ok, body };
  }

  async function postJson(path, body) {
    const response = await apiFetch(path, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    return { status: response.status, ok: response.ok, body: parsed, text };
  }

  async function openProject(dir) {
    const result = await postJson("/api/projects/open", { dir });
    if (!result.ok) {
      throw new Error(
        `openProject failed (${result.status}): ${result.text || JSON.stringify(result.body)}`
      );
    }
    return result.body.project;
  }

  async function createSession(projectKey) {
    const result = await postJson("/api/sessions", { projectKey });
    if (!result.ok) {
      throw new Error(
        `createSession failed (${result.status}): ${result.text || JSON.stringify(result.body)}`
      );
    }
    return result.body.session;
  }

  async function getSession(sessionId) {
    const result = await getJson(`/api/sessions/${encodeURIComponent(sessionId)}`);
    if (!result.ok) {
      throw new Error(`getSession failed (${result.status})`);
    }
    return result.body.session;
  }

  async function listMemories(sessionId, { includeRetired = true } = {}) {
    const q = new URLSearchParams({
      sessionId,
      includeRetired: includeRetired ? "1" : "0",
    });
    const result = await getJson(`/api/memories?${q}`);
    if (!result.ok) {
      throw new Error(`listMemories failed (${result.status}): ${JSON.stringify(result.body)}`);
    }
    return result.body;
  }

  async function getMessages(sessionId) {
    const result = await getJson(`/api/messages?sessionId=${encodeURIComponent(sessionId)}`);
    if (!result.ok) {
      throw new Error(`getMessages failed (${result.status})`);
    }
    return result.body.messages || [];
  }

  async function getUsage(sessionId) {
    const result = await getJson(`/api/sessions/${encodeURIComponent(sessionId)}/usage`);
    return result;
  }

  async function listTraces(sessionId) {
    const result = await getJson(`/api/sessions/${encodeURIComponent(sessionId)}/traces`);
    if (!result.ok) throw new Error(`listTraces failed (${result.status})`);
    return result.body.traces || [];
  }

  async function inspectTrace(sessionId, traceId) {
    const result = await getJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/traces/${encodeURIComponent(traceId)}`
    );
    if (!result.ok) throw new Error(`inspectTrace failed (${result.status})`);
    return result.body.trace;
  }

  async function observabilityMetrics() {
    return getJson("/api/storage/observability/metrics");
  }

  async function health() {
    return getJson("/api/storage/health");
  }

  async function agents() {
    return getJson("/api/agents");
  }

  /**
   * Full chat turn: read SSE until connection ends.
   * @returns {Promise<{ status, text, events, assistantText, summary, durationMs }>}
   */
  async function chat({ sessionId, agent, prompt, useWorktree, signal, timeoutMs }) {
    const controller = new AbortController();
    const timer =
      timeoutMs > 0
        ? setTimeout(
            () => controller.abort(new Error(`turn timeout after ${timeoutMs}ms`)),
            timeoutMs
          )
        : null;
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    }

    const started = Date.now();
    try {
      const body = { sessionId, agent, prompt };
      if (useWorktree === true) body.useWorktree = true;

      const response = await apiFetch("/api/chat", {
        method: "POST",
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      const events = parseSse(text);
      return {
        status: response.status,
        ok: response.ok,
        text,
        events,
        assistantText: extractAssistantText(events),
        summary: summarizeEvents(events),
        durationMs: Date.now() - started,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    baseUrl: root,
    uiToken,
    apiFetch,
    getJson,
    postJson,
    openProject,
    createSession,
    getSession,
    listMemories,
    getMessages,
    getUsage,
    listTraces,
    inspectTrace,
    observabilityMetrics,
    health,
    agents,
    chat,
  };
}

module.exports = { createApiClient };

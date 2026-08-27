"use strict";

/**
 * Minimal SHIFT HTTP/SSE client for live scenarios.
 * Talks to the same /api surface the web UI uses.
 */

const UI_TOKEN_HEADER = "x-shift-ui-token";

function createApiClient({ baseUrl, token }) {
  async function request(method, url, body) {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        [UI_TOKEN_HEADER]: token,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      throw new Error(`${method} ${url} failed (${response.status}): ${text.slice(0, 500)}`);
    }
    return parsed;
  }

  async function openProject(dir) {
    const result = await request("POST", "/api/projects/open", { dir });
    if (!result?.project?.projectKey) {
      throw new Error(`openProject returned no projectKey: ${JSON.stringify(result).slice(0, 300)}`);
    }
    return result.project;
  }

  async function createSession(projectKey) {
    const result = await request("POST", "/api/sessions", { projectKey });
    if (!result?.session?.id) {
      throw new Error(`createSession returned no id: ${JSON.stringify(result).slice(0, 300)}`);
    }
    return result.session;
  }

  /**
   * POST /api/chat and collect the whole SSE stream.
   * Resolves with collected events once the stream ends (`done` or socket close).
   */
  async function chat({ sessionId, agent, prompt, clientTurnId, timeoutMs, onEvent = () => {} }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("chat timeout")), timeoutMs);
    const events = [];
    try {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          [UI_TOKEN_HEADER]: token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sessionId, agent, prompt, clientTurnId }),
      });
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        throw new Error(`chat failed (${response.status}): ${text.slice(0, 500)}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = parseSseFrame(frame);
          if (event) {
            events.push(event);
            onEvent(event);
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally {
      clearTimeout(timer);
    }
    return events;
  }

  function parseSseFrame(frame) {
    let name = "";
    const dataLines = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!name && dataLines.length === 0) return null;
    let data = null;
    if (dataLines.length > 0) {
      try {
        data = JSON.parse(dataLines.join("\n"));
      } catch {
        data = dataLines.join("\n");
      }
    }
    return { name, data };
  }

  async function listTraces(sessionId) {
    const result = await request("GET", `/api/sessions/${encodeURIComponent(sessionId)}/traces`);
    return result?.traces || [];
  }

  async function getTrace(sessionId, traceId) {
    const result = await request(
      "GET",
      `/api/sessions/${encodeURIComponent(sessionId)}/traces/${encodeURIComponent(traceId)}`
    );
    return result?.trace || null;
  }

  async function getMessages(sessionId) {
    const result = await request("GET", `/api/messages?sessionId=${encodeURIComponent(sessionId)}`);
    return result?.messages || [];
  }

  return { openProject, createSession, chat, listTraces, getTrace, getMessages };
}

function summarizeChatEvents(events) {
  const summary = {
    invocationId: "",
    exitCode: null,
    assistantText: "",
    sseError: "",
    sealed: false,
    sawDone: false,
  };
  const textChunks = [];
  for (const event of events) {
    if (event.name === "agent-start" && !summary.invocationId) {
      summary.invocationId = event.data?.invocationId || "";
    } else if (event.name === "message" && event.data?.role === "assistant") {
      textChunks.push(String(event.data.text || ""));
    } else if (event.name === "agent-exit") {
      summary.exitCode = event.data?.code ?? null;
    } else if (event.name === "error" && !summary.sseError) {
      summary.sseError = String(event.data?.message || "unknown chat error");
    } else if (event.name === "sealed" || event.name === "window-sealed") {
      summary.sealed = true;
    } else if (event.name === "done") {
      summary.sawDone = true;
    }
  }
  summary.assistantText = textChunks.join("");
  return summary;
}

module.exports = { createApiClient, summarizeChatEvents };

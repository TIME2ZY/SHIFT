import { ApiError, authenticatedFetch } from "../shared/api/client";
import { parseSseChunk, type SseFrame } from "./sse-parser";
import type { SessionRunStore } from "./session-run-store";

export interface ChatRequest {
  sessionId: string;
  agentId: string;
  prompt: string;
  projectDir?: string;
  useWorktree?: boolean;
}

export interface ChatStreamResult {
  sessionId: string;
  malformedFrames: number;
  doneReceived: boolean;
}

interface CanonicalAgentEvent {
  type?: string;
  agent?: string;
  invocationId?: string;
  text?: string;
  error?: string;
}

function objectData(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

export async function runChatStream(
  request: ChatRequest,
  store: SessionRunStore,
  controller: AbortController
): Promise<ChatStreamResult> {
  let boundSessionId = request.sessionId;
  let malformedFrames = 0;
  let doneReceived = false;
  let hasStructuredEvents = false;

  const response = await authenticatedFetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent: request.agentId,
      prompt: request.prompt,
      sessionId: request.sessionId,
      projectDir: request.projectDir,
      useWorktree: request.useWorktree === true,
    }),
    signal: controller.signal,
    timeoutMs: 0,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error || response.statusText, response.status, body);
  }
  if (!response.body) throw new Error("服务器没有返回可读取的消息流。");

  function handleFrame({ event, data }: SseFrame) {
    const payload = objectData(data);

    switch (event) {
      case "session": {
        const nextSessionId =
          typeof payload.sessionId === "string" ? payload.sessionId : boundSessionId;
        if (nextSessionId !== boundSessionId) {
          store.dispatch({
            type: "session/rekeyed",
            from: boundSessionId,
            to: nextSessionId,
          });
          boundSessionId = nextSessionId;
        }
        break;
      }

      case "agent-start":
        store.dispatch({
          type: "agent/started",
          sessionId: boundSessionId,
          agentId: typeof payload.agent === "string" ? payload.agent : request.agentId,
          invocationId: typeof payload.invocationId === "string" ? payload.invocationId : undefined,
        });
        break;

      case "agent-event": {
        hasStructuredEvents = true;
        const agentEvent = payload as CanonicalAgentEvent;
        const agentId = agentEvent.agent || request.agentId;
        if (agentEvent.type === "text.delta" && agentEvent.text) {
          store.dispatch({
            type: "message/delta",
            sessionId: boundSessionId,
            agentId,
            text: agentEvent.text,
          });
        } else if (agentEvent.type === "run.failed") {
          store.dispatch({
            type: "run/failed",
            sessionId: boundSessionId,
            error: agentEvent.error || "Agent 运行失败。",
          });
        }
        break;
      }

      case "message":
        if (!hasStructuredEvents && typeof payload.text === "string") {
          store.dispatch({
            type: "message/delta",
            sessionId: boundSessionId,
            agentId: typeof payload.agent === "string" ? payload.agent : request.agentId,
            text: payload.text,
          });
        }
        break;

      case "agent-exit":
        store.dispatch({
          type: "agent/finished",
          sessionId: boundSessionId,
          agentId: typeof payload.agent === "string" ? payload.agent : request.agentId,
          failed: typeof payload.code === "number" && payload.code !== 0,
        });
        break;

      case "a2a-route": {
        const from = typeof payload.from === "string" ? payload.from : "Agent";
        const to = typeof payload.to === "string" ? payload.to : "Agent";
        store.dispatch({
          type: "notice/received",
          sessionId: boundSessionId,
          message: `${from} → ${to}`,
        });
        break;
      }

      case "sealed":
        store.dispatch({
          type: "notice/received",
          sessionId: boundSessionId,
          message: "上下文已封存，本轮运行停止。",
        });
        break;

      case "error":
        store.dispatch({
          type: "run/failed",
          sessionId: boundSessionId,
          error: typeof payload.message === "string" ? payload.message : "运行失败。",
        });
        break;

      case "done":
        doneReceived = true;
        store.dispatch({ type: "run/done", sessionId: boundSessionId });
        break;
    }
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseChunk(buffer, handleFrame);
    buffer = parsed.rest;
    malformedFrames += parsed.malformed;
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const parsed = parseSseChunk(`${buffer}\n\n`, handleFrame);
    malformedFrames += parsed.malformed;
  }

  if (!doneReceived && !controller.signal.aborted) {
    throw new Error("消息流在完成事件之前中断。");
  }

  return { sessionId: boundSessionId, malformedFrames, doneReceived };
}

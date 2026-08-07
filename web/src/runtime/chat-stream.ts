import { ApiError, authenticatedFetch } from "../shared/api/client";
import { agentExitIndicatesFailure } from "../shared/contracts/run-status";
import { parseSseChunk, type SseFrame } from "./sse-parser";
import type { SessionRunStore } from "./session-run-store";

export interface ChatRequest {
  sessionId: string;
  agentId: string;
  prompt: string;
  projectDir?: string;
  useWorktree?: boolean;
  clientTurnId?: string;
}

export interface ChatStreamResult {
  sessionId: string;
  malformedFrames: number;
  doneReceived: boolean;
}

export interface ChatStreamEvents {
  onMemory?(payload: Record<string, unknown>, sessionId: string): void;
  onMemoryInject?(payload: Record<string, unknown>, sessionId: string): void;
  onMemoryMetrics?(payload: Record<string, unknown>, sessionId: string): void;
  onRunError?(message: string, sessionId: string): void;
}

interface CanonicalAgentEvent {
  type?: string;
  agent?: string;
  invocationId?: string;
  text?: string;
  error?: string;
  toolName?: string;
  title?: string;
  label?: string;
  toolKind?: string;
  toolId?: string;
  status?: string;
  output?: string;
  result?: unknown;
  path?: string;
  changeType?: string;
  args?: Record<string, unknown>;
  items?: Array<{
    id?: string;
    label?: string;
    text?: string;
    status?: string;
  }>;
}

/** Prefer human text for TaskOutput / Text tool results over raw JSON dumps. */
export function formatToolResultForDisplay(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result !== "object") return String(result);
  const obj = result as Record<string, unknown>;
  if (typeof obj.text === "string" && obj.text.trim()) return obj.text;
  const nested = obj.Result ?? obj.result;
  if (nested && typeof nested === "object") {
    const r = nested as Record<string, unknown>;
    if (typeof r.output === "string" && r.output.trim()) {
      const meta: string[] = [];
      if (typeof r.status === "string") meta.push(r.status);
      if (typeof r.exit_code === "number") meta.push(`exit ${r.exit_code}`);
      if (typeof r.duration_secs === "number") meta.push(`${r.duration_secs}s`);
      const head = meta.length ? `${meta.join(" · ")}\n` : "";
      return `${head}${r.output}`;
    }
    if (typeof r.command === "string" && r.command.trim()) {
      return r.command;
    }
  }
  if (obj.Content && typeof obj.Content === "object") {
    const c = obj.Content as Record<string, unknown>;
    if (typeof c.content === "string") return c.content;
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function objectData(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

export async function runChatStream(
  request: ChatRequest,
  store: SessionRunStore,
  controller: AbortController,
  events: ChatStreamEvents = {}
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
      clientTurnId: request.clientTurnId,
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
            invocationId: agentEvent.invocationId,
            text: agentEvent.text,
          });
        } else if (agentEvent.type === "thinking.delta" && agentEvent.text) {
          store.dispatch({
            type: "thinking/delta",
            sessionId: boundSessionId,
            agentId,
            invocationId: agentEvent.invocationId,
            text: agentEvent.text,
          });
        } else if (agentEvent.type === "tool.started" && agentEvent.toolId && agentEvent.toolName) {
          store.dispatch({
            type: "tool/started",
            sessionId: boundSessionId,
            agentId,
            invocationId: agentEvent.invocationId,
            toolId: agentEvent.toolId,
            toolName: agentEvent.toolName,
            input: agentEvent.args,
            title: agentEvent.title,
            label: agentEvent.label,
            toolKind: agentEvent.toolKind,
          });
        } else if (agentEvent.type === "tool.finished" && agentEvent.toolId) {
          store.dispatch({
            type: "tool/finished",
            sessionId: boundSessionId,
            agentId,
            invocationId: agentEvent.invocationId,
            toolId: agentEvent.toolId,
            toolName: agentEvent.toolName,
            failed: ["error", "failed"].includes(agentEvent.status || ""),
            input: agentEvent.args,
            output:
              agentEvent.output ??
              (agentEvent.result === undefined
                ? undefined
                : typeof agentEvent.result === "string"
                  ? agentEvent.result
                  : formatToolResultForDisplay(agentEvent.result)),
            error: agentEvent.error,
            title: agentEvent.title,
            label: agentEvent.label,
            toolKind: agentEvent.toolKind,
          });
        } else if (agentEvent.type === "file.changed" && agentEvent.path) {
          store.dispatch({
            type: "file/changed",
            sessionId: boundSessionId,
            agentId,
            invocationId: agentEvent.invocationId,
            path: agentEvent.path,
            changeType: agentEvent.changeType,
          });
        } else if (agentEvent.type === "progress.update" && agentEvent.items) {
          store.dispatch({
            type: "progress/updated",
            sessionId: boundSessionId,
            agentId,
            invocationId: agentEvent.invocationId,
            items: agentEvent.items.map((item, index) => ({
              id: item.id || `step-${index + 1}`,
              label: item.label || item.text || `步骤 ${index + 1}`,
              status: item.status || "pending",
            })),
          });
        } else if (agentEvent.type === "run.failed") {
          const message = agentEvent.error || "Agent 运行失败。";
          store.dispatch({
            type: "run/failed",
            sessionId: boundSessionId,
            error: message,
          });
          events.onRunError?.(message, boundSessionId);
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
          invocationId: typeof payload.invocationId === "string" ? payload.invocationId : undefined,
          // Align with server finish: non-zero exit or OS signal ⇒ failed/aborted terminal.
          failed: agentExitIndicatesFailure(payload),
        });
        break;

      case "a2a-route": {
        // Agent handoffs are execution metadata. They remain available in the
        // process history, but do not interrupt the user-facing transcript.
        break;
      }

      case "sealed":
        store.dispatch({
          type: "notice/received",
          sessionId: boundSessionId,
          message: "上下文已封存，本轮运行停止。",
        });
        break;

      case "memory":
        events.onMemory?.(payload, boundSessionId);
        break;

      case "memory-inject":
        events.onMemoryInject?.(payload, boundSessionId);
        break;

      case "memory-metrics":
        events.onMemoryMetrics?.(payload, boundSessionId);
        break;

      case "error": {
        const message = typeof payload.message === "string" ? payload.message : "运行失败。";
        store.dispatch({
          type: "run/failed",
          sessionId: boundSessionId,
          error: message,
        });
        events.onRunError?.(message, boundSessionId);
        break;
      }

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

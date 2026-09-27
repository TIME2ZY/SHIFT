import { projectToolStatus } from "../shared/contracts/tool-status";
import { ApiError, authenticatedFetch } from "../shared/api/client";
import { agentExitIndicatesFailure } from "../shared/contracts/run-status";
import { formatToolResultForDisplay } from "./chat-stream";
import { parseSseChunk, type SseFrame } from "./sse-parser";
import type { SessionRunStore } from "./session-run-store";

export interface RunStreamEvents {
  onMemory?(payload: Record<string, unknown>, sessionId: string): void;
  onMemoryInject?(payload: Record<string, unknown>, sessionId: string): void;
  onMemoryMetrics?(payload: Record<string, unknown>, sessionId: string): void;
  onRunError?(message: string, sessionId: string): void;
  onStateChange?(sessionId: string): void;
  onAgentExit?(sessionId: string, invocationId: string): void;
}

interface CanonicalAgentEvent {
  type?: string;
  agent?: string;
  subagentId?: string;
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
  items?: Array<{ id?: string; label?: string; text?: string; status?: string }>;
}

function objectData(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason || new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

export function applyRunEventFrame(
  sessionId: string,
  frame: SseFrame,
  store: SessionRunStore,
  events: RunStreamEvents = {},
  seenIds?: Set<number>
): number | null {
  const cursor = frame.id != null && frame.id !== "" ? Number(frame.id) : null;
  if (cursor != null && Number.isFinite(cursor)) {
    if (seenIds?.has(cursor)) return cursor;
    seenIds?.add(cursor);
    store.dispatch({ type: "run/cursor", sessionId, cursor });
  }

  const payload = objectData(frame.data);
  const run = store.getSnapshot().runs[sessionId];
  const traceId = typeof payload.traceId === "string" ? payload.traceId : undefined;
  if (frame.event !== "snapshot" && traceId && traceId !== run?.traceId) {
    // Only a live start may select a new Trace. Replay and late superseded
    // terminals still advance the cursor, but cannot mutate the current run.
    if (frame.event === "agent-start" && cursor != null && cursor > (run?.replayThrough ?? 0)) {
      store.dispatch({ type: "run/started", sessionId, traceId, startedAt: Date.now() });
    } else {
      return cursor;
    }
  }

  if (
    [
      "snapshot",
      "callback-post",
      "message",
      "a2a-route",
      "handoff-parsed",
      "handoff-repair-needed",
      "agent-start",
      "agent-exit",
      "done",
      "run.aborted",
      "window-sealed",
      "context-restored",
      "task-state-updated",
      "task-state-rejected",
    ].includes(frame.event) ||
    /^(code-review|implementation-plan|delivery-|final-acceptance|solution-baseline)/.test(
      frame.event
    ) ||
    (frame.event === "agent-event" && payload.type === "run.failed")
  ) {
    events.onStateChange?.(sessionId);
  }
  switch (frame.event) {
    case "snapshot": {
      const traceId = typeof payload.traceId === "string" ? payload.traceId : undefined;
      const runStatus = typeof payload.runStatus === "string" ? payload.runStatus : undefined;
      store.dispatch({
        type: "run/hydrated",
        sessionId,
        traceId,
        runStatus,
        replayThrough: Number(payload.lastEventId) || 0,
      });
      break;
    }
    case "agent-start": {
      const agentId = typeof payload.agent === "string" ? payload.agent : "unknown";
      const invocationId = String(payload.invocationId || "");
      if (!invocationId) break;
      store.dispatch({ type: "agent/started", sessionId, agentId, invocationId });
      break;
    }
    case "agent-event": {
      const agentEvent = { ...payload } as CanonicalAgentEvent;
      if (agentEvent.subagentId) {
        const source = "[子 Agent " + agentEvent.subagentId + "] ";
        if (agentEvent.text) agentEvent.text = source + agentEvent.text;
        if (agentEvent.toolName)
          agentEvent.title = source + (agentEvent.title || agentEvent.toolName);
        if (agentEvent.type === "progress.update") {
          agentEvent.type = "commentary.delta";
          agentEvent.text =
            source + (agentEvent.items || []).map((i) => i.label || i.text || "").join(" · ");
        }
      }
      const agentId = agentEvent.agent || "unknown";
      const invocationId = String(agentEvent.invocationId || "");
      if (!invocationId) break;
      if (agentEvent.type === "text.delta" && agentEvent.text) {
        store.dispatch({
          type: "message/delta",
          sessionId,
          agentId,
          invocationId,
          text: agentEvent.text,
        });
      } else if (agentEvent.type === "commentary.delta" && agentEvent.text) {
        store.dispatch({
          type: "commentary/delta",
          sessionId,
          agentId,
          invocationId,
          text: agentEvent.text,
        });
      } else if (agentEvent.type === "thinking.delta" && agentEvent.text) {
        store.dispatch({
          type: "thinking/delta",
          sessionId,
          agentId,
          invocationId,
          text: agentEvent.text,
        });
      } else if (agentEvent.type === "tool.started" && agentEvent.toolId && agentEvent.toolName) {
        store.dispatch({
          type: "tool/started",
          sessionId,
          agentId,
          invocationId,
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
          status: projectToolStatus(agentEvent.status, Boolean(agentEvent.error)),
          sessionId,
          agentId,
          invocationId,
          toolId: agentEvent.toolId,
          toolName: agentEvent.toolName,
          failed: projectToolStatus(agentEvent.status, Boolean(agentEvent.error)) !== "done",
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
          sessionId,
          agentId,
          invocationId,
          path: agentEvent.path,
          changeType: agentEvent.changeType,
        });
      } else if (agentEvent.type === "progress.update" && agentEvent.items) {
        store.dispatch({
          type: "progress/updated",
          sessionId,
          agentId,
          invocationId,
          items: agentEvent.items.map((item, index) => ({
            id: item.id || `step-${index + 1}`,
            label: item.label || item.text || `步骤 ${index + 1}`,
            status: item.status || "pending",
          })),
        });
      } else if (agentEvent.type === "run.failed") {
        const message = agentEvent.error || "Agent 运行失败。";
        store.dispatch({ type: "run/failed", sessionId, error: message });
        events.onRunError?.(message, sessionId);
      }
      break;
    }
    case "agent-exit": {
      const agentId = typeof payload.agent === "string" ? payload.agent : "unknown";
      const invocationId = String(payload.invocationId || "");
      if (!invocationId) break;
      store.dispatch({
        type: "agent/finished",
        sessionId,
        agentId,
        invocationId,
        failed: agentExitIndicatesFailure(payload),
      });
      events.onAgentExit?.(sessionId, invocationId);
      break;
    }
    case "sealed":
      store.dispatch({
        type: "notice/received",
        sessionId,
        message: "上下文窗口已封存；运行状态以执行终态为准。",
      });
      break;
    case "task-state-rejected":
      store.dispatch({
        type: "notice/received",
        sessionId,
        message: `任务状态更新未接受：${String(payload.reason || "证据无效")}`,
      });
      break;
    case "memory":
      events.onMemory?.(payload, sessionId);
      break;
    case "memory-inject":
      events.onMemoryInject?.(payload, sessionId);
      break;
    case "memory-metrics":
      events.onMemoryMetrics?.(payload, sessionId);
      break;
    case "error": {
      const message =
        typeof payload.message === "string"
          ? payload.message
          : typeof payload.error === "string"
            ? payload.error
            : "运行失败。";
      store.dispatch({ type: "run/failed", sessionId, error: message });
      events.onRunError?.(message, sessionId);
      break;
    }
    case "run.aborted":
      store.dispatch({ type: "run/aborted", sessionId });
      break;
    case "done":
      store.dispatch({ type: "run/done", sessionId });
      break;
    case "invocation-end": {
      const reason = typeof payload.reason === "string" ? payload.reason : "";
      const forced = payload.forcedTerminal === true;
      if (forced || reason === "restart-reconcile") {
        const message = "运行被服务重启中断。";
        store.dispatch({ type: "run/failed", sessionId, error: message });
        events.onRunError?.(message, sessionId);
      }
      break;
    }
    default:
      break;
  }

  return cursor != null && Number.isFinite(cursor) ? cursor : null;
}

export const RECONNECT_BASE_DELAY_MS = 500;
export const RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * Delay for the nth reconnect attempt: 500ms, 1s, 2s, 4s ... capped at 30s.
 * The cap is a simplicity bound, not load spreading: a session may have
 * several subscribers (see architecture-map D10), and they reconnect
 * independently on their own cursors.
 */
export function reconnectDelay(
  attempt: number,
  baseDelayMs = RECONNECT_BASE_DELAY_MS,
  maxDelayMs = RECONNECT_MAX_DELAY_MS
): number {
  const grown = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(grown, maxDelayMs);
}

export async function subscribeRunEvents(
  sessionId: string,
  store: SessionRunStore,
  controller: AbortController,
  events: RunStreamEvents = {},
  { baseDelayMs = RECONNECT_BASE_DELAY_MS, maxDelayMs = RECONNECT_MAX_DELAY_MS } = {}
): Promise<{ malformedFrames: number }> {
  let malformedFrames = 0;
  const seenIds = new Set<number>();
  let cursor = store.getSnapshot().runs[sessionId]?.cursor ?? 0;
  let attempt = 0;

  while (!controller.signal.aborted) {
    try {
      const params = cursor > 0 ? `?after=${encodeURIComponent(String(cursor))}` : "";
      const response = await authenticatedFetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/events${params}`,
        {
          method: "GET",
          headers: {
            accept: "text/event-stream",
            ...(cursor > 0 ? { "Last-Event-ID": String(cursor) } : {}),
          },
          signal: controller.signal,
          timeoutMs: 0,
        }
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new ApiError(body.error || response.statusText, response.status, body);
      }
      if (!response.body) throw new Error("服务器没有返回可读取的消息流。");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let receivedFrame = false;
      try {
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) throw new Error("服务器关闭了消息流。");
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseSseChunk(buffer, (frame) => {
            if (!receivedFrame) {
              receivedFrame = true;
              if (attempt > 0) store.dispatch({ type: "run/connected", sessionId });
              attempt = 0;
            }
            const next = applyRunEventFrame(sessionId, frame, store, events, seenIds);
            if (next != null) cursor = Math.max(cursor, next);
          });
          buffer = parsed.rest;
          malformedFrames += parsed.malformed;
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      if (controller.signal.aborted) break;
      if (
        error instanceof ApiError &&
        (error.status === 401 || error.status === 403 || error.status === 404)
      ) {
        // 401/403: the UI token is gone — retrying cannot fix it, and the run
        // would otherwise sit in a fake "running" state forever. 404: the
        // session no longer exists. Both are terminal for this subscriber.
        const message =
          error.status === 404
            ? "会话不存在或已被删除，无法继续接收运行事件。"
            : "鉴权失败，无法接收运行事件；请重新打开页面。";
        store.dispatch({ type: "run/failed", sessionId, error: message });
        events.onRunError?.(message, sessionId);
        break;
      }
      attempt += 1;
      const delayMs = reconnectDelay(attempt, baseDelayMs, maxDelayMs);
      store.dispatch({ type: "run/reconnecting", sessionId, attempt, delayMs });
      await sleep(delayMs, controller.signal).catch(() => {});
    }
  }

  return { malformedFrames };
}

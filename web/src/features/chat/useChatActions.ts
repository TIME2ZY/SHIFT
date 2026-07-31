import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { queryKeys } from "../../shared/api/queryKeys";
import type { MemoryInjectEvent } from "../memory/queries";
import { useToast } from "../notifications/ToastProvider";
import { runChatStream } from "../../runtime/chat-stream";
import { useSessionRunStore } from "../../runtime/session-run-provider";

export function useChatActions() {
  const queryClient = useQueryClient();
  const store = useSessionRunStore();
  const toast = useToast();

  const send = useCallback(
    async (sessionId: string, agentId: string, prompt: string, useWorktree = false) => {
      const content = prompt.trim();
      if (!content) return;

      const controller = store.startController(sessionId);
      store.dispatch({
        type: "user/submitted",
        sessionId,
        agentId,
        content,
      });

      let resultSessionId = sessionId;
      let memoryDirty = false;
      try {
        const result = await runChatStream(
          { sessionId, agentId, prompt: content, useWorktree },
          store,
          controller,
          {
            onMemory(payload) {
              memoryDirty = true;
              toast.show(
                payload.action === "invalidate" ? "Agent 已否定一条记忆" : "Agent 已写入记忆",
                { variant: "ok" }
              );
            },
            onMemoryInject(payload, eventSessionId) {
              const memoryInject = payload as MemoryInjectEvent;
              queryClient.setQueryData(
                queryKeys.sessions.memoryInject(eventSessionId),
                memoryInject
              );
              const count = Number(memoryInject.count || memoryInject.items?.length || 0);
              if (count > 0) {
                toast.show(`本回合注入 ${count} 条记忆`, { variant: "ok" });
              }
            },
            onMemoryMetrics(payload) {
              if (Number(payload.totalWrites || 0) > 0) {
                memoryDirty = true;
              }
            },
            onRunError(message) {
              toast.show(message, { variant: "error", ttl: 7000 });
            },
          }
        );
        resultSessionId = result.sessionId;
        if (result.malformedFrames > 0) {
          store.dispatch({
            type: "notice/received",
            sessionId: resultSessionId,
            message: `消息流中有 ${result.malformedFrames} 个事件无法解析。`,
          });
          toast.show(`消息流中有 ${result.malformedFrames} 个事件无法解析。`, {
            variant: "error",
          });
        }
      } catch (error) {
        if (!controller.signal.aborted && store.isCurrentController(resultSessionId, controller)) {
          const message = error instanceof Error ? error.message : "连接中断。";
          store.dispatch({
            type: "run/failed",
            sessionId: resultSessionId,
            error: message,
          });
          toast.show(message, { variant: "error", ttl: 7000 });
        }
      } finally {
        const owned = store.releaseController(resultSessionId, controller);
        if (owned) {
          const syncs = [
            queryClient.invalidateQueries({
              queryKey: queryKeys.sessions.messages(resultSessionId),
            }),
            queryClient.invalidateQueries({
              queryKey: queryKeys.sessions.usage(resultSessionId),
            }),
            queryClient.invalidateQueries({ queryKey: queryKeys.sessions.list }),
          ];
          if (memoryDirty) {
            syncs.push(
              queryClient.invalidateQueries({
                queryKey: queryKeys.sessions.memories(resultSessionId),
              })
            );
          }
          await Promise.all(syncs);
          store.dispatch({ type: "run/synced", sessionId: resultSessionId });
        }
      }
    },
    [queryClient, store, toast]
  );

  const stop = useCallback(
    (sessionId: string) => {
      const stopped = store.abort(sessionId);
      if (stopped) toast.show("已停止当前运行。");
      return stopped;
    },
    [store, toast]
  );

  return { send, stop };
}

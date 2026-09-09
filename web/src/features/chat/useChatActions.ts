import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { queryKeys } from "../../shared/api/queryKeys";
import type { MemoryInjectEvent } from "../memory/queries";
import { useToast } from "../notifications/ToastProvider";
import { startRun, stopRun } from "../../runtime/run-api";
import { subscribeRunEvents } from "../../runtime/run-event-stream";
import { useSessionRunStore } from "../../runtime/session-run-provider";

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export function useChatActions() {
  const queryClient = useQueryClient();
  const store = useSessionRunStore();
  const toast = useToast();
  const startControllersRef = useRef(new Map<string, AbortController>());

  const send = useCallback(
    async (
      sessionId: string,
      agentId: string,
      prompt: string,
      useWorktree: boolean,
      clientTurnId: string
    ) => {
      const content = prompt.trim();
      if (!content) return;

      store.dispatch({
        type: "user/submitted",
        sessionId,
        agentId,
        content,
        clientTurnId,
      });

      const startController = new AbortController();
      startControllersRef.current.get(sessionId)?.abort();
      startControllersRef.current.set(sessionId, startController);
      store.dispatch({
        type: "run/started",
        sessionId,
        startedAt: Date.now(),
      });

      let accepted = false;
      try {
        const started = await startRun({
          sessionId,
          agentId,
          prompt: content,
          useWorktree,
          clientTurnId,
        });
        accepted = true;
        if (startControllersRef.current.get(sessionId) === startController) {
          store.dispatch({ type: "run/accepted", sessionId, traceId: started.traceId });
        }
        if (startController.signal.aborted) {
          const outcome = await stopRun(sessionId, started.traceId);
          if (startControllersRef.current.get(sessionId) === startController && outcome.stopped) {
            store.abort(sessionId);
            toast.show("已停止当前运行。");
          }
          return;
        }
      } catch (error) {
        if (startControllersRef.current.get(sessionId) !== startController) return;
        if (isAbortError(error)) return;
        const message = error instanceof Error ? error.message : "启动运行失败。";
        if (!accepted) store.dispatch({ type: "run/failed", sessionId, error: message });
        toast.show(message, { variant: "error", ttl: 7000 });
      } finally {
        if (startControllersRef.current.get(sessionId) === startController) {
          startControllersRef.current.delete(sessionId);
        }
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: queryKeys.sessions.messages(sessionId),
          }),
          queryClient.invalidateQueries({
            queryKey: queryKeys.sessions.usage(sessionId),
          }),
          queryClient.invalidateQueries({
            queryKey: queryKeys.sessions.collaboration(sessionId),
          }),
          queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all }),
        ]);
        store.dispatch({ type: "run/synced", sessionId });
      }
    },
    [queryClient, store, toast]
  );

  const stop = useCallback(
    (sessionId: string) => {
      const pendingStart = startControllersRef.current.get(sessionId);
      if (pendingStart) {
        pendingStart.abort();
        return true;
      }
      const traceId = store.getSnapshot().runs[sessionId]?.traceId;
      if (!traceId) {
        toast.show("尚未取得运行标识，无法确认停止。", { variant: "error" });
        return false;
      }
      void stopRun(sessionId, traceId)
        .then((outcome) => {
          if (outcome.stopped) {
            store.abort(sessionId);
            toast.show("已停止当前运行。");
          }
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : "停止失败。";
          toast.show(message, { variant: "error", ttl: 7000 });
        });
      return true;
    },
    [store, toast]
  );

  const restore = useCallback(
    (sessionId: string) => {
      const controller = store.startSubscription(sessionId);
      void subscribeRunEvents(sessionId, store, controller, {
        onMemory(payload) {
          toast.show(
            payload.action === "invalidate" ? "Agent 已否定一条记忆" : "Agent 已写入记忆",
            { variant: "ok" }
          );
        },
        onMemoryInject(payload, eventSessionId) {
          queryClient.setQueryData(
            queryKeys.sessions.memoryInject(eventSessionId),
            payload as MemoryInjectEvent
          );
          const memoryInject = payload as MemoryInjectEvent;
          const count = Number(memoryInject.count || memoryInject.items?.length || 0);
          if (count > 0) {
            toast.show(`本回合注入 ${count} 条记忆`, { variant: "ok" });
          }
        },
        onMemoryMetrics(payload) {
          if (Number(payload.totalWrites || 0) > 0) {
            void queryClient.invalidateQueries({
              queryKey: queryKeys.sessions.memories(sessionId),
            });
          }
        },
        onRunError(message) {
          toast.show(message, { variant: "error", ttl: 7000 });
        },
        onStateChange(eventSessionId) {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.sessions.detail(eventSessionId),
          });
          void queryClient.invalidateQueries({
            queryKey: ["observability", "trace", eventSessionId],
          });
        },
        onAgentExit(eventSessionId, invocationId) {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.sessions.messages(eventSessionId),
          });
          void queryClient.invalidateQueries({
            queryKey: queryKeys.sessions.usage(eventSessionId),
          });
          void queryClient.invalidateQueries({
            queryKey: queryKeys.sessions.invocationProcess(eventSessionId, invocationId),
          });
        },
      }).catch((error) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "观察流中断。";
        toast.show(message, { variant: "error", ttl: 7000 });
      });
      return () => {
        if (store.isCurrentSubscription(sessionId, controller)) {
          store.stopSubscription(sessionId);
        }
      };
    },
    [queryClient, store, toast]
  );

  return { send, stop, restore };
}

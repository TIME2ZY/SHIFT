import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { queryKeys } from "../shared/api/queryKeys";
import type { MemoryInjectEvent } from "../features/memory/queries";
import { useToast } from "../features/notifications/ToastProvider";
import { subscribeRunEvents } from "./run-event-stream";
import { useSessionRunStore } from "./session-run-provider";

export function useSessionObserver() {
  const queryClient = useQueryClient();
  const store = useSessionRunStore();
  const toast = useToast();
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

  return { restore };
}

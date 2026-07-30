import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { sessionQueryKeys } from "../sessions/queries";
import { runChatStream } from "../../runtime/chat-stream";
import { useSessionRunStore } from "../../runtime/session-run-provider";

export function useChatActions() {
  const queryClient = useQueryClient();
  const store = useSessionRunStore();

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
      try {
        const result = await runChatStream(
          { sessionId, agentId, prompt: content, useWorktree },
          store,
          controller
        );
        resultSessionId = result.sessionId;
        if (result.malformedFrames > 0) {
          store.dispatch({
            type: "notice/received",
            sessionId: resultSessionId,
            message: `消息流中有 ${result.malformedFrames} 个事件无法解析。`,
          });
        }
      } catch (error) {
        if (!controller.signal.aborted && store.isCurrentController(resultSessionId, controller)) {
          store.dispatch({
            type: "run/failed",
            sessionId: resultSessionId,
            error: error instanceof Error ? error.message : "连接中断。",
          });
        }
      } finally {
        const owned = store.releaseController(resultSessionId, controller);
        if (owned) {
          await Promise.all([
            queryClient.invalidateQueries({
              queryKey: sessionQueryKeys.messages(resultSessionId),
            }),
            queryClient.invalidateQueries({ queryKey: sessionQueryKeys.all }),
          ]);
          store.dispatch({ type: "run/synced", sessionId: resultSessionId });
        }
      }
    },
    [queryClient, store]
  );

  const stop = useCallback((sessionId: string) => store.abort(sessionId), [store]);

  return { send, stop };
}

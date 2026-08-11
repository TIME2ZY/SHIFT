import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../../shared/api/client";
import { queryKeys } from "../../shared/api/queryKeys";

async function discardWorktree(sessionId: string): Promise<void> {
  await apiRequest(`/api/sessions/${encodeURIComponent(sessionId)}/worktree/discard`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

export function useDiscardWorktreeMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: discardWorktree,
    onSuccess: async (_data, sessionId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions.workspace(sessionId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all }),
      ]);
    },
  });
}

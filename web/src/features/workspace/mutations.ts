import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../../shared/api/client";
import { queryKeys } from "../../shared/api/queryKeys";

interface UpdateProjectDirInput {
  sessionId: string;
  dir: string;
}

async function updateProjectDir({ sessionId, dir }: UpdateProjectDirInput): Promise<string> {
  const response = await apiRequest<{ dir?: string }>("/api/project", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, dir }),
  });
  return response.dir || "";
}

async function discardWorktree(sessionId: string): Promise<void> {
  await apiRequest(`/api/sessions/${encodeURIComponent(sessionId)}/worktree/discard`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

export function useUpdateProjectDirMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: updateProjectDir,
    onSuccess: async (_dir, { sessionId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions.workspace(sessionId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions.list }),
      ]);
    },
  });
}

export function useDiscardWorktreeMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: discardWorktree,
    onSuccess: async (_data, sessionId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions.workspace(sessionId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions.list }),
      ]);
    },
  });
}

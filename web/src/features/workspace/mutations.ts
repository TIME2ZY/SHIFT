import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../../shared/api/client";
import { sessionQueryKeys } from "../sessions/queries";
import { workspaceQueryKeys } from "./queries";

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

export function useUpdateProjectDirMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: updateProjectDir,
    onSuccess: async (_dir, { sessionId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.session(sessionId) }),
        queryClient.invalidateQueries({ queryKey: sessionQueryKeys.all }),
      ]);
    },
  });
}

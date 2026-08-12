import { useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../shared/api/queryKeys";
import { archiveProject, openProject, restoreProject } from "./api";
import type { ProjectSummary } from "./types";

function useProjectLifecycleMutation(mutationFn: (projectKey: string) => Promise<ProjectSummary>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all }),
      ]);
    },
  });
}

export function useOpenProjectMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: openProject,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects.all });
    },
  });
}

export function useArchiveProjectMutation() {
  return useProjectLifecycleMutation(archiveProject);
}

export function useRestoreProjectMutation() {
  return useProjectLifecycleMutation(restoreProject);
}

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../shared/api/queryKeys";
import { createSession, deleteSession } from "./api";
import type { SessionSummary } from "./types";

export function useCreateSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createSession,
    onSuccess: (session, projectKey) => {
      queryClient.setQueryData<SessionSummary[]>(
        queryKeys.sessions.list(projectKey),
        (current = []) => [session, ...current.filter((item) => item.id !== session.id)]
      );
    },
  });
}

export function useDeleteSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId }: { sessionId: string; projectKey: string }) =>
      deleteSession(sessionId),
    onSuccess: (_data, { sessionId, projectKey }) => {
      queryClient.setQueryData<SessionSummary[]>(
        queryKeys.sessions.list(projectKey),
        (current = []) => current.filter((session) => session.id !== sessionId)
      );
      queryClient.removeQueries({ queryKey: queryKeys.sessions.detail(sessionId) });
    },
  });
}

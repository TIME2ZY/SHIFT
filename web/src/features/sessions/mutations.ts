import { useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../shared/api/queryKeys";
import { createSession, deleteSession } from "./api";
import type { SessionSummary } from "./types";

export function useCreateSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createSession,
    onSuccess: (session) => {
      queryClient.setQueryData<SessionSummary[]>(queryKeys.sessions.list, (current = []) => [
        session,
        ...current.filter((item) => item.id !== session.id),
      ]);
    },
  });
}

export function useDeleteSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteSession,
    onSuccess: (_data, sessionId) => {
      queryClient.setQueryData<SessionSummary[]>(queryKeys.sessions.list, (current = []) =>
        current.filter((session) => session.id !== sessionId)
      );
      queryClient.removeQueries({ queryKey: queryKeys.sessions.detail(sessionId) });
    },
  });
}

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createSession, deleteSession } from "./api";
import { sessionQueryKeys } from "./queries";

export function useCreateSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createSession,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sessionQueryKeys.all });
    },
  });
}

export function useDeleteSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteSession,
    onSuccess: async (_data, sessionId) => {
      queryClient.removeQueries({ queryKey: sessionQueryKeys.messages(sessionId) });
      await queryClient.invalidateQueries({ queryKey: sessionQueryKeys.all });
    },
  });
}

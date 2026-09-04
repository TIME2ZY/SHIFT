import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../shared/api/queryKeys";
import { decideSessionAcceptance, getSessionCollaboration } from "./api";

export function useCollaborationQuery(sessionId: string | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.sessions.collaboration(sessionId ?? ""),
    queryFn: ({ signal }) => getSessionCollaboration(sessionId!, signal),
    enabled: enabled && Boolean(sessionId),
  });
}

export function useAcceptanceDecision(sessionId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { verdict: "accepted" | "rejected" | "incomplete"; note?: string }) =>
      decideSessionAcceptance(sessionId!, input),
    onSuccess(response) {
      queryClient.setQueryData(queryKeys.sessions.collaboration(sessionId!), response);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.sessions.collaboration(sessionId!),
      });
    },
  });
}

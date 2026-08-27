import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "../../shared/api/queryKeys";
import { getSessionCollaboration } from "./api";

export function useCollaborationQuery(sessionId: string | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.sessions.collaboration(sessionId ?? ""),
    queryFn: ({ signal }) => getSessionCollaboration(sessionId!, signal),
    enabled: enabled && Boolean(sessionId),
  });
}

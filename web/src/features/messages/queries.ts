import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "../../shared/api/queryKeys";
import { listMessages } from "./api";

export function useMessagesQuery(sessionId: string | null) {
  return useQuery({
    queryKey: queryKeys.sessions.messages(sessionId ?? ""),
    queryFn: ({ signal }) => listMessages(sessionId!, signal),
    enabled: Boolean(sessionId),
  });
}

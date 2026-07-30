import { useQuery } from "@tanstack/react-query";
import { sessionQueryKeys } from "../sessions/queries";
import { listMessages } from "./api";

export function useMessagesQuery(sessionId: string | null) {
  return useQuery({
    queryKey: sessionQueryKeys.messages(sessionId ?? ""),
    queryFn: ({ signal }) => listMessages(sessionId!, signal),
    enabled: Boolean(sessionId),
  });
}

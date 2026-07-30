import { useQuery } from "@tanstack/react-query";
import { listSessions } from "./api";

export const sessionQueryKeys = {
  all: ["sessions"] as const,
  messages: (sessionId: string) => ["sessions", sessionId, "messages"] as const,
  usage: (sessionId: string) => ["sessions", sessionId, "usage"] as const,
};

export function useSessionsQuery() {
  return useQuery({
    queryKey: sessionQueryKeys.all,
    queryFn: ({ signal }) => listSessions(signal),
  });
}

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "../../shared/api/queryKeys";
import { listSessionTraces } from "./api";

export function useSessionTracesQuery(sessionId: string | null) {
  return useQuery({
    queryKey: queryKeys.sessions.traces(sessionId || ""),
    queryFn: ({ signal }) => listSessionTraces(sessionId!, signal),
    enabled: Boolean(sessionId),
  });
}

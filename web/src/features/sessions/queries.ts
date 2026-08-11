import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "../../shared/api/queryKeys";
import { listSessions } from "./api";

export function useSessionsQuery(projectKey: string | null) {
  return useQuery({
    queryKey: queryKeys.sessions.list(projectKey ?? ""),
    queryFn: ({ signal }) => listSessions(projectKey!, signal),
    enabled: Boolean(projectKey),
  });
}

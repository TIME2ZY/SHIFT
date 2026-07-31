import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "../../shared/api/queryKeys";
import { listSessions } from "./api";

export function useSessionsQuery() {
  return useQuery({
    queryKey: queryKeys.sessions.list,
    queryFn: ({ signal }) => listSessions(signal),
  });
}

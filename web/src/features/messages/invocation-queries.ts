import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "../../shared/api/queryKeys";
import { getInvocationProcess } from "./invocation-api";

export function useInvocationProcessQuery(
  sessionId: string | null,
  invocationId: string | undefined,
  enabled = true
) {
  return useQuery({
    queryKey: queryKeys.sessions.invocationProcess(sessionId ?? "", invocationId ?? ""),
    queryFn: ({ signal }) => getInvocationProcess(sessionId!, invocationId!, signal),
    enabled: enabled && Boolean(sessionId && invocationId),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}

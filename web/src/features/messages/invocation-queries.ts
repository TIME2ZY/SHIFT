import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "../../shared/api/queryKeys";
import { getInvocationProcess } from "./invocation-api";

export function useInvocationProcessQuery(
  sessionId: string | null,
  invocationId: string | undefined,
  detail: "summary" | "full",
  enabled: boolean
) {
  return useQuery({
    queryKey: queryKeys.sessions.invocationProcess(sessionId ?? "", invocationId ?? "", detail),
    queryFn: ({ signal }) => getInvocationProcess(sessionId!, invocationId!, detail, signal),
    enabled: enabled && Boolean(sessionId && invocationId),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "../../shared/api/queryKeys";
import { getObservabilityMetrics, listSessionTraces } from "./api";

export function useSessionTracesQuery(sessionId: string | null) {
  return useQuery({
    queryKey: queryKeys.sessions.traces(sessionId || ""),
    queryFn: ({ signal }) => listSessionTraces(sessionId!, signal),
    enabled: Boolean(sessionId),
  });
}

export function useObservabilityMetricsQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.observability.metrics,
    queryFn: ({ signal }) => getObservabilityMetrics(signal),
    enabled,
  });
}

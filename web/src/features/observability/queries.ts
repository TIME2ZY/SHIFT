import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "../../shared/api/queryKeys";
import { getObservabilityMetrics, listSessionTraces } from "./api";
import type { TraceSearchFilters } from "./types";

export function useSessionTracesQuery(sessionId: string | null, filters: TraceSearchFilters = {}) {
  return useQuery({
    queryKey: [...queryKeys.sessions.traces(sessionId || ""), filters],
    queryFn: ({ signal }) => listSessionTraces(sessionId!, filters, signal),
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

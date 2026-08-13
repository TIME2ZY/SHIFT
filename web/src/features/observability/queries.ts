import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "../../shared/api/queryKeys";
import {
  getObservabilityHealth,
  getObservabilityMetrics,
  inspectSessionTrace,
  listSessionTraces,
} from "./api";
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

export function useObservabilityHealthQuery(enabled = true) {
  return useQuery({
    queryKey: ["observability", "health"],
    queryFn: ({ signal }) => getObservabilityHealth(signal),
    enabled,
    refetchInterval: 30_000,
  });
}

export function useTraceDetailQuery(sessionId: string | null | undefined, traceId: string | null) {
  return useQuery({
    queryKey: ["observability", "trace", sessionId, traceId],
    queryFn: ({ signal }) => inspectSessionTrace(sessionId!, traceId!, signal),
    enabled: Boolean(sessionId && traceId),
  });
}

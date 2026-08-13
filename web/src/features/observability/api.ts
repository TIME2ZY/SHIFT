import { apiRequest } from "../../shared/api/client";
import type {
  ObservabilityHealth,
  ObservabilityMetrics,
  TraceSearchFilters,
  TraceSearchResult,
} from "./types";

export async function listSessionTraces(
  sessionId: string,
  filters: TraceSearchFilters = {},
  signal?: AbortSignal
) {
  const params = new URLSearchParams();
  if (filters.state) params.set("state", filters.state);
  if (filters.agentId) params.set("agentId", filters.agentId);
  if (filters.query) params.set("q", filters.query);
  if (filters.failuresOnly) params.set("failuresOnly", "1");
  if (filters.limit) params.set("limit", String(filters.limit));
  if (filters.offset) params.set("offset", String(filters.offset));
  const response = await apiRequest<TraceSearchResult>(
    `/api/sessions/${encodeURIComponent(sessionId)}/traces?${params}`,
    { signal }
  );
  return response;
}

export async function exportSessionTrace(sessionId: string, traceId: string) {
  return apiRequest<Record<string, unknown>>(
    `/api/sessions/${encodeURIComponent(sessionId)}/traces/${encodeURIComponent(traceId)}/export`
  );
}

export async function inspectSessionTrace(
  sessionId: string,
  traceId: string,
  signal?: AbortSignal
) {
  const response = await apiRequest<{ trace: import("./types").TraceSummary }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/traces/${encodeURIComponent(traceId)}`,
    { signal }
  );
  return response.trace;
}

export async function getObservabilityMetrics(signal?: AbortSignal) {
  const response = await apiRequest<{ metrics: ObservabilityMetrics }>(
    "/api/storage/observability/metrics",
    { signal }
  );
  return response.metrics;
}

export async function getObservabilityHealth(signal?: AbortSignal) {
  const response = await apiRequest<{ storage: { observability: ObservabilityHealth } }>(
    "/api/storage/health",
    { signal }
  );
  return response.storage.observability;
}

import { apiRequest } from "../../shared/api/client";
import type { ObservabilityMetrics, TraceSummary } from "./types";

export async function listSessionTraces(sessionId: string, signal?: AbortSignal) {
  const response = await apiRequest<{ traces: TraceSummary[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/traces`,
    { signal }
  );
  return response.traces || [];
}

export async function getObservabilityMetrics(signal?: AbortSignal) {
  const response = await apiRequest<{ metrics: ObservabilityMetrics }>(
    "/api/storage/observability/metrics",
    { signal }
  );
  return response.metrics;
}

import { apiRequest } from "../../shared/api/client";
import type { TraceSummary } from "./types";

export async function listSessionTraces(sessionId: string, signal?: AbortSignal) {
  const response = await apiRequest<{ traces: TraceSummary[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/traces`,
    { signal }
  );
  return response.traces || [];
}

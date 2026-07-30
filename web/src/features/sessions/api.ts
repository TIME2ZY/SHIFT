import { apiRequest } from "../../shared/api/client";
import type { SessionSummary, SessionsResponse } from "./types";

export async function listSessions(signal?: AbortSignal): Promise<SessionSummary[]> {
  const response = await apiRequest<SessionsResponse>("/api/sessions", { signal });
  return Array.isArray(response.sessions) ? response.sessions : [];
}

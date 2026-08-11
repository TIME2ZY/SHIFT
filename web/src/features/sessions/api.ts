import { apiRequest } from "../../shared/api/client";
import type { SessionSummary, SessionsResponse } from "./types";

export async function listSessions(
  projectKey: string,
  signal?: AbortSignal
): Promise<SessionSummary[]> {
  const response = await apiRequest<SessionsResponse>(
    `/api/projects/${encodeURIComponent(projectKey)}/sessions`,
    { signal }
  );
  return Array.isArray(response.sessions) ? response.sessions : [];
}

export async function createSession(projectKey: string): Promise<SessionSummary> {
  const response = await apiRequest<{ session: SessionSummary }>("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectKey }),
  });
  return response.session;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await apiRequest(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

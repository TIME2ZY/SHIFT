import { apiRequest } from "../../shared/api/client";
import type { CollaborationResponse } from "./types";

export function getSessionCollaboration(sessionId: string, signal?: AbortSignal) {
  return apiRequest<CollaborationResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/collaboration`,
    { signal }
  );
}

export function decideSessionAcceptance(
  sessionId: string,
  input: { verdict: "accepted" | "rejected" | "incomplete"; note?: string }
) {
  return apiRequest<CollaborationResponse & { recorded: true }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/collaboration/acceptance`,
    { method: "POST", body: JSON.stringify(input) }
  );
}

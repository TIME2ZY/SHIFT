import { apiRequest } from "../../shared/api/client";
import type { CollaborationResponse } from "./types";

export function getSessionCollaboration(sessionId: string, signal?: AbortSignal) {
  return apiRequest<CollaborationResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/collaboration`,
    { signal }
  );
}

import { apiRequest } from "../../shared/api/client";
import type { MessagesResponse, PersistedMessage } from "./types";

export async function listMessages(
  sessionId: string,
  signal?: AbortSignal
): Promise<PersistedMessage[]> {
  const query = new URLSearchParams({ sessionId });
  const response = await apiRequest<MessagesResponse>(`/api/messages?${query}`, { signal });
  return Array.isArray(response.messages) ? response.messages : [];
}

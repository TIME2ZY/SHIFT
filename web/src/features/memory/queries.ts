import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../shared/api/client";

export interface MemoryItem {
  id: string;
  kind?: string;
  topic?: string;
  content: string;
  status?: string;
  scope?: string;
  createdAt?: string | number;
}

interface MemoryResponse {
  memories: MemoryItem[];
  counts?: Record<string, number>;
}

async function listMemories(sessionId: string, signal?: AbortSignal): Promise<MemoryResponse> {
  const query = new URLSearchParams({
    sessionId,
    includeRetired: "0",
    limit: "50",
  });
  const response = await apiRequest<MemoryResponse>(`/api/memories?${query}`, { signal });
  return {
    memories: Array.isArray(response.memories) ? response.memories : [],
    counts: response.counts || {},
  };
}

export function useMemoriesQuery(sessionId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["sessions", sessionId ?? "", "memories"],
    queryFn: ({ signal }) => listMemories(sessionId!, signal),
    enabled: enabled && Boolean(sessionId),
  });
}

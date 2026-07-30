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

export interface MemoryInjectItem {
  id?: string;
  kind?: string;
  topic?: string;
  content?: string;
}

export interface MemoryInjectEvent {
  sessionId?: string;
  count?: number;
  items?: MemoryInjectItem[];
  availability?: {
    state?: string;
    reason?: string;
  };
}

export const memoryQueryKeys = {
  list: (sessionId: string) => ["sessions", sessionId, "memories"] as const,
  inject: (sessionId: string) => ["sessions", sessionId, "memory-inject"] as const,
};

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
    queryKey: memoryQueryKeys.list(sessionId ?? ""),
    queryFn: ({ signal }) => listMemories(sessionId!, signal),
    enabled: enabled && Boolean(sessionId),
  });
}

export function useMemoryInjectQuery(sessionId: string | null) {
  return useQuery({
    queryKey: memoryQueryKeys.inject(sessionId ?? ""),
    queryFn: async (): Promise<MemoryInjectEvent | null> => null,
    enabled: false,
    initialData: null,
  });
}

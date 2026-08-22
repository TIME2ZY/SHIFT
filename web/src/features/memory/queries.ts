import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../shared/api/client";
import { queryKeys } from "../../shared/api/queryKeys";

export interface MemoryItem {
  id: string;
  kind?: string;
  topic?: string;
  content: string;
  status?: string;
  scope?: string;
  createdAt?: string | number;
  sourceMessageId?: string | null;
  sourceInvocationId?: string | null;
  createdBy?: string | null;
  supersededBy?: string | null;
  metadata?: Record<string, unknown> | null;
  anchors?: unknown[] | null;
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
    queryKey: queryKeys.sessions.memories(sessionId ?? ""),
    queryFn: ({ signal }) => listMemories(sessionId!, signal),
    enabled: enabled && Boolean(sessionId),
  });
}

export interface MemoryUsageEntry {
  searched: number;
  injected: number;
}

export type MemoryUsage = Record<string, MemoryUsageEntry>;

async function listMemoryUsage(sessionId: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ sessionId });
  const response = await apiRequest<{ usage: MemoryUsage }>(`/api/memories/usage?${query}`, {
    signal,
  });
  return response.usage || {};
}

export function useMemoryUsageQuery(sessionId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.sessions.memoryUsage(sessionId ?? ""),
    queryFn: ({ signal }) => listMemoryUsage(sessionId!, signal),
    enabled: enabled && Boolean(sessionId),
  });
}

export function useMemoryInjectQuery(sessionId: string | null) {
  return useQuery({
    queryKey: queryKeys.sessions.memoryInject(sessionId ?? ""),
    queryFn: async (): Promise<MemoryInjectEvent | null> => null,
    enabled: false,
    initialData: null,
  });
}

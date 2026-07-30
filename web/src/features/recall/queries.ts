import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../shared/api/client";

export type RecallLayer = "memory" | "message" | "evidence" | "project-doc";

export interface InvocationSummary {
  invocationId: string;
  agent?: string;
  startedAt?: string;
  endedAt?: string | null;
  state?: string | null;
  eventCount?: number;
}

export interface InvocationEvent {
  id?: string | number;
  invocationId?: string;
  eventNo?: number;
  sequenceNo?: number;
  kind: string;
  payload?: Record<string, unknown>;
  ts?: string;
  createdAt?: string;
}

export interface InvocationPage {
  invocationId: string;
  events: InvocationEvent[];
  total: number;
  from: number;
  limit: number;
}

export interface RecallHit {
  sourceId?: string;
  invocationId?: string;
  eventNo?: number;
  memoryId?: string;
  layer: RecallLayer;
  kind?: string;
  sourceKind?: string;
  score?: number;
  ts?: string;
  snippet?: string;
  content?: string;
  memoryStatus?: string;
  memoryTopic?: string;
  agent?: string;
}

export interface RecallSearchResult {
  hits: RecallHit[];
  layers: Partial<Record<RecallLayer, number>>;
  query: string;
  limit: number;
  truncated: boolean;
  weakQuery: boolean;
}

async function listInvocations(
  sessionId: string,
  signal?: AbortSignal
): Promise<InvocationSummary[]> {
  const query = new URLSearchParams({ sessionId });
  const response = await apiRequest<{ invocations?: InvocationSummary[] }>(
    `/api/callbacks/list-invocations?${query}`,
    { signal }
  );
  return Array.isArray(response.invocations) ? response.invocations : [];
}

async function searchRecall(
  sessionId: string,
  searchText: string,
  signal?: AbortSignal
): Promise<RecallSearchResult> {
  const query = new URLSearchParams({
    sessionId,
    query: searchText,
    limit: "30",
  });
  const response = await apiRequest<Partial<RecallSearchResult>>(
    `/api/callbacks/session-search?${query}`,
    { signal }
  );
  return {
    hits: Array.isArray(response.hits) ? response.hits : [],
    layers: response.layers || {},
    query: response.query ?? searchText,
    limit: Number(response.limit) || 30,
    truncated: Boolean(response.truncated),
    weakQuery: Boolean(response.weakQuery),
  };
}

async function readInvocation(
  sessionId: string,
  invocationId: string,
  signal?: AbortSignal
): Promise<InvocationPage> {
  const query = new URLSearchParams({
    sessionId,
    targetInvocationId: invocationId,
    from: "0",
    limit: "120",
  });
  return apiRequest<InvocationPage>(`/api/callbacks/read-invocation?${query}`, { signal });
}

export function useInvocationsQuery(sessionId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["sessions", sessionId ?? "", "invocations"],
    queryFn: ({ signal }) => listInvocations(sessionId!, signal),
    enabled: enabled && Boolean(sessionId),
  });
}

export function useRecallSearchQuery(
  sessionId: string | null,
  searchText: string,
  enabled: boolean
) {
  return useQuery({
    queryKey: ["sessions", sessionId ?? "", "recall", searchText],
    queryFn: ({ signal }) => searchRecall(sessionId!, searchText, signal),
    enabled: enabled && Boolean(sessionId) && Boolean(searchText),
  });
}

export function useInvocationQuery(
  sessionId: string | null,
  invocationId: string | null,
  enabled: boolean
) {
  return useQuery({
    queryKey: ["sessions", sessionId ?? "", "invocations", invocationId ?? ""],
    queryFn: ({ signal }) => readInvocation(sessionId!, invocationId!, signal),
    enabled: enabled && Boolean(sessionId) && Boolean(invocationId),
  });
}

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../shared/api/client";
import { queryKeys } from "../../shared/api/queryKeys";
import type { UsageSummary } from "./types";

export function useUsageQuery(sessionId: string | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.sessions.usage(sessionId ?? ""),
    queryFn: ({ signal }) =>
      apiRequest<UsageSummary>(`/api/sessions/${encodeURIComponent(sessionId!)}/usage`, { signal }),
    enabled: enabled && Boolean(sessionId),
  });
}

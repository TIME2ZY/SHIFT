import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../shared/api/client";
import { sessionQueryKeys } from "../sessions/queries";
import type { UsageSummary } from "./types";

export function useUsageQuery(sessionId: string | null) {
  return useQuery({
    queryKey: sessionQueryKeys.usage(sessionId ?? ""),
    queryFn: ({ signal }) =>
      apiRequest<UsageSummary>(`/api/sessions/${encodeURIComponent(sessionId!)}/usage`, { signal }),
    enabled: Boolean(sessionId),
  });
}

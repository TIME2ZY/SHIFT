import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../../shared/api/client";
import { queryKeys } from "../../shared/api/queryKeys";
import type { AgentsResponse } from "./types";

export function useAgentsQuery() {
  return useQuery({
    queryKey: queryKeys.agents.all,
    queryFn: async ({ signal }) => {
      const response = await apiRequest<AgentsResponse>("/api/agents", { signal });
      return Array.isArray(response.agents) ? response.agents : [];
    },
    staleTime: 60_000,
    refetchInterval: (query) =>
      query.state.data?.some((agent) => agent.availability?.checking) ? 1_000 : 10_000,
  });
}

export function useRefreshAgentMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (agent: string) =>
      apiRequest<AgentsResponse>("/api/agents/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent }),
      }),
    onSuccess: (response) => client.setQueryData(queryKeys.agents.all, response.agents),
  });
}

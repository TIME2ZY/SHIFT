import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../shared/api/client";
import type { AgentsResponse } from "./types";

export function useAgentsQuery() {
  return useQuery({
    queryKey: ["agents"],
    queryFn: async ({ signal }) => {
      const response = await apiRequest<AgentsResponse>("/api/agents", { signal });
      return Array.isArray(response.agents) ? response.agents : [];
    },
    staleTime: 60_000,
  });
}

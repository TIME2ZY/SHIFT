import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../../shared/api/client";
import type { DelegationTask, DelegationContract } from "./types";
const taskKeys = {
  all: ["delegations"] as const,
  detail: (id: string | null) => ["delegations", id] as const,
};
export function useTasksQuery() {
  return useQuery({
    queryKey: taskKeys.all,
    queryFn: () => apiRequest<{ tasks: DelegationTask[]; recoveryBlocked: boolean }>("/api/tasks"),
    refetchInterval: 2000,
  });
}
export function useTaskQuery(id: string | null) {
  return useQuery({
    queryKey: taskKeys.detail(id),
    enabled: Boolean(id),
    queryFn: () =>
      apiRequest<{
        task: DelegationTask;
        busy: boolean;
        preparingThreadId: string | null;
        recoveryBlocked: boolean;
      }>("/api/tasks/" + id),
    refetchInterval: 1500,
    retry: false,
  });
}
export function useTaskActions() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      input:
        | { action: "create"; projectKey?: string; parentThreadId?: string }
        | { action: "prepare"; id: string; prompt: string }
        | { action: "save"; id: string; contract: DelegationContract; expectedRevision: number }
        | { action: "submit"; id: string; expectedRevision: number }
        | { action: "cancel"; id: string }
    ) => {
      if (input.action === "create")
        return apiRequest<{ task: DelegationTask }>("/api/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
      const { action, id, ...body } = input;
      return apiRequest<{ task?: DelegationTask; traceId?: string }>(
        "/api/tasks/" + id + (action === "save" ? "" : "/" + action),
        {
          method: action === "save" ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            action === "prepare" ? { ...body, clientTurnId: crypto.randomUUID() } : body
          ),
        }
      );
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: taskKeys.all });
      await client.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
}

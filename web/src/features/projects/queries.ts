import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "../../shared/api/queryKeys";
import { listProjects } from "./api";

export function useProjectsQuery() {
  return useQuery({
    queryKey: queryKeys.projects.active,
    queryFn: ({ signal }) => listProjects(false, signal),
  });
}

export function useArchivedProjectsQuery(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.projects.archived,
    queryFn: ({ signal }) => listProjects(true, signal),
    enabled,
  });
}

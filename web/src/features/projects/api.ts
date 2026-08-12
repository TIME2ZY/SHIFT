import { apiRequest } from "../../shared/api/client";
import type { ProjectSummary, ProjectsResponse } from "./types";

export async function listProjects(
  archived = false,
  signal?: AbortSignal
): Promise<ProjectSummary[]> {
  const suffix = archived ? "?archived=true" : "";
  const response = await apiRequest<ProjectsResponse>(`/api/projects${suffix}`, { signal });
  return Array.isArray(response.projects) ? response.projects : [];
}

export async function openProject(dir: string): Promise<ProjectSummary> {
  const response = await apiRequest<{ project: ProjectSummary }>("/api/projects/open", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir }),
  });
  return response.project;
}

async function changeProjectLifecycle(
  projectKey: string,
  action: "archive" | "restore"
): Promise<ProjectSummary> {
  const response = await apiRequest<{ project: ProjectSummary }>(
    `/api/projects/${encodeURIComponent(projectKey)}/${action}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
  );
  return response.project;
}

export function archiveProject(projectKey: string): Promise<ProjectSummary> {
  return changeProjectLifecycle(projectKey, "archive");
}

export function restoreProject(projectKey: string): Promise<ProjectSummary> {
  return changeProjectLifecycle(projectKey, "restore");
}

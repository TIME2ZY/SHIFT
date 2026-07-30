import { useQuery } from "@tanstack/react-query";
import { apiRequest, authenticatedFetch } from "../../shared/api/client";

export interface WorktreeStatus {
  branch?: string;
  worktreeDir?: string;
  baseDir?: string;
  clean?: boolean;
  porcelain?: string[];
}

export interface WorkspaceSnapshot {
  projectDir: string;
  worktree: WorktreeStatus | null;
}

async function readWorkspace(
  sessionId: string,
  worktreeAttached: boolean,
  signal?: AbortSignal
): Promise<WorkspaceSnapshot> {
  const projectQuery = new URLSearchParams({ sessionId });
  const project = await apiRequest<{ dir?: string }>(`/api/project?${projectQuery}`, {
    signal,
  });

  if (!worktreeAttached) {
    return { projectDir: project.dir || "", worktree: null };
  }

  const statusResponse = await authenticatedFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/worktree/status`,
    { signal }
  );

  if ([400, 404].includes(statusResponse.status)) {
    return { projectDir: project.dir || "", worktree: null };
  }

  const worktree = (await statusResponse.json()) as WorktreeStatus;
  if (!statusResponse.ok) {
    throw new Error("无法加载工作区状态。");
  }

  return { projectDir: project.dir || "", worktree };
}

export function useWorkspaceQuery(
  sessionId: string | null,
  worktreeAttached: boolean,
  enabled: boolean
) {
  return useQuery({
    queryKey: ["sessions", sessionId ?? "", "workspace", worktreeAttached],
    queryFn: ({ signal }) => readWorkspace(sessionId!, worktreeAttached, signal),
    enabled: enabled && Boolean(sessionId),
  });
}

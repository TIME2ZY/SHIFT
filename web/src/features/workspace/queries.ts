import { useQuery } from "@tanstack/react-query";
import { apiRequest, authenticatedFetch } from "../../shared/api/client";

export interface WorktreeStatus {
  branch?: string;
  worktreeDir?: string;
  baseDir?: string;
  clean?: boolean;
  porcelain?: string[];
  previewUrl?: string;
}

export interface WorkspaceSnapshot {
  projectDir: string;
  worktree: WorktreeStatus | null;
}

export interface WorkspaceDetail extends WorkspaceSnapshot {
  diff: string;
  diffTruncated: boolean;
  diffTotalChars: number;
}

export const workspaceQueryKeys = {
  session: (sessionId: string) => ["sessions", sessionId, "workspace"] as const,
  detail: (sessionId: string, worktreeAttached: boolean) =>
    [...workspaceQueryKeys.session(sessionId), worktreeAttached] as const,
};

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

export function useWorkspaceDetailQuery(
  sessionId: string | null,
  worktreeAttached: boolean,
  enabled: boolean
) {
  return useQuery({
    queryKey: workspaceQueryKeys.detail(sessionId ?? "", worktreeAttached),
    queryFn: async ({ signal }): Promise<WorkspaceDetail> => {
      const workspace = await readWorkspace(sessionId!, worktreeAttached, signal);
      if (!workspace.worktree) {
        return {
          ...workspace,
          diff: "",
          diffTruncated: false,
          diffTotalChars: 0,
        };
      }

      const response = await authenticatedFetch(
        `/api/sessions/${encodeURIComponent(sessionId!)}/worktree/diff`,
        { signal }
      );
      if ([400, 404].includes(response.status)) {
        return {
          ...workspace,
          worktree: null,
          diff: "",
          diffTruncated: false,
          diffTotalChars: 0,
        };
      }
      const data = (await response.json()) as {
        diff?: string;
        truncated?: boolean;
        totalChars?: number;
      };
      if (!response.ok) throw new Error("无法加载工作区 Diff。");
      return {
        ...workspace,
        diff: data.diff || "",
        diffTruncated: data.truncated === true,
        diffTotalChars: Number(data.totalChars || data.diff?.length || 0),
      };
    },
    enabled: enabled && Boolean(sessionId),
  });
}

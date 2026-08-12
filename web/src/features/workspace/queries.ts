import { useQuery } from "@tanstack/react-query";
import { apiRequest, authenticatedFetch } from "../../shared/api/client";
import { queryKeys } from "../../shared/api/queryKeys";

export interface WorktreeStatus {
  branch?: string;
  worktreeDir?: string;
  baseDir?: string;
  clean?: boolean;
  porcelain?: string[];
  previewUrl?: string;
}

export interface WorkspaceSnapshot {
  sessionId: string;
  projectKey: string;
  projectDir: string;
  worktree: WorktreeStatus | null;
}

export interface WorkspaceDetail extends WorkspaceSnapshot {
  diff: string;
  diffTruncated: boolean;
  diffTotalChars: number;
}

async function readWorkspace(sessionId: string, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
  return apiRequest<WorkspaceSnapshot>(`/api/sessions/${encodeURIComponent(sessionId)}/workspace`, {
    signal,
  });
}

export function useWorkspaceDetailQuery(sessionId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.sessions.workspace(sessionId ?? ""),
    queryFn: async ({ signal }): Promise<WorkspaceDetail> => {
      const workspace = await readWorkspace(sessionId!, signal);
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

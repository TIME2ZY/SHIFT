export interface SessionSummary {
  id: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  lastAgent?: string;
  projectDir?: string;
  worktree?: {
    branch?: string;
    worktreeDir?: string;
  } | null;
}

export interface SessionsResponse {
  sessions: SessionSummary[];
}

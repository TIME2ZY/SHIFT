export interface SessionSummary {
  id: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  messageCount: number;
  lastAgent?: string;
  participantAgentIds?: string[];
  projectDir?: string;
  projectKey?: string | null;
  worktree?: {
    branch?: string;
    worktreeDir?: string;
  } | null;
}

export interface SessionsResponse {
  sessions: SessionSummary[];
}

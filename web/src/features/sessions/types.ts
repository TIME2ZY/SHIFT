export interface SessionSummary {
  id: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  lastAgent?: string;
  projectDir?: string;
}

export interface SessionsResponse {
  sessions: SessionSummary[];
}

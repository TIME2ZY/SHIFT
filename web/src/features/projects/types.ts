export interface ProjectSummary {
  projectKey: string;
  identityKind: string;
  canonicalPath: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  archivedAt: string | null;
  threadCount: number;
}

export interface ProjectsResponse {
  projects: ProjectSummary[];
}

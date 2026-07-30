export interface AgentSummary {
  id: string;
  label: string;
  mention?: string;
  description?: string;
}

export interface AgentsResponse {
  agents: AgentSummary[];
}

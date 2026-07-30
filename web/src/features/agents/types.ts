export interface AgentSummary {
  id: string;
  label: string;
  description?: string;
}

export interface AgentsResponse {
  agents: AgentSummary[];
}

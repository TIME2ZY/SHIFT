export interface AgentSummary {
  id: string;
  label: string;
  mention?: string;
  description?: string;
  model?: string;
  modelVendor?: string;
}

export interface AgentsResponse {
  agents: AgentSummary[];
}

export interface AgentSummary {
  id: string;
  label: string;
  mention?: string;
  description?: string;
  model?: string;
  modelVendor?: string;
  role?: string;
  duties?: string[];
  boundaries?: string[];
  workflowRole?: string;
  workflowCapabilities?: string[];
  workflowResponsibilities?: string[];
}

export interface AgentsResponse {
  agents: AgentSummary[];
}

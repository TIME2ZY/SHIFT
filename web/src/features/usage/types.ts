export interface BillingUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface ContextUsage {
  contextWindowTokens?: number;
  usableContextTokens?: number;
  contextUsedTokens?: number;
  remainingTokens?: number;
  budgetFillRatio?: number;
  contextUsageSource?: string;
}

export interface AgentUsage {
  agentId: string;
  billing?: BillingUsage;
  context?: ContextUsage | null;
}

export interface UsageSummary {
  available: boolean;
  session: BillingUsage;
  agents: AgentUsage[];
}

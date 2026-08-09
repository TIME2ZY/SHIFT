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
  state?: string;
  sealReason?: string | null;
}

export interface AgentUsage {
  agentId: string;
  billing?: BillingUsage;
  billingComplete?: boolean;
  context?: ContextUsage | null;
  recentSealedContext?: ContextUsage | null;
}

export interface UsageSummary {
  available: boolean;
  session: BillingUsage;
  agents: AgentUsage[];
}

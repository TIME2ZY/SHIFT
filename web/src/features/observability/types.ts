export interface ExecutionOutcome {
  terminalReason: string | null;
  failureStage: string | null;
  errorCode: string | null;
  retryable: boolean | null;
}

export interface ExecutionInvocation {
  invocationId: string;
  traceId: string;
  agentId: string;
  state: "active" | "completed" | "failed" | "aborted";
  parentInvocationId: string | null;
  triggerMessageId: string | null;
  triggerType: string | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  outcome: ExecutionOutcome;
}

export interface ExecutionHandoff {
  handoffId: string;
  sourceInvocationId: string;
  targetInvocationId: string | null;
  sourceAgent: string;
  targetAgent: string;
  routeStatus: string;
  receiveStatus: string;
  completeStatus: string;
  outcome: ExecutionOutcome;
}

export interface TraceSummary {
  traceId: string;
  threadId: string;
  clientTurnId: string | null;
  requestAttempt: number;
  state: "active" | "completed" | "failed" | "aborted";
  startedAt: string;
  endedAt: string | null;
  outcome: ExecutionOutcome;
  invocationCounts: Record<string, number>;
  handoffCounts: Record<string, number>;
  invocations: ExecutionInvocation[];
  handoffs: ExecutionHandoff[];
  spans?: TraceSpan[];
  links?: TraceLink[];
}

export interface TraceSpan {
  spanId: string;
  invocationId: string;
  parentSpanId: string | null;
  kind: "generation" | "tool" | "recall";
  name: string;
  state: string;
  complete: boolean;
  startedAt: string | null;
  endedAt: string | null;
  attributes: Record<string, string | number | boolean | null>;
}

export interface TraceLink {
  linkId: string;
  kind: "handoff";
  sourceSpanId: string;
  targetSpanId: string;
}

export interface TraceSearchFilters {
  state?: TraceSummary["state"] | "";
  agentId?: string;
  query?: string;
  failuresOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface TraceSearchResult {
  traces: TraceSummary[];
  page: { total: number; limit: number; offset: number };
}

export interface QualifiedRate {
  value: number | null;
  numerator: number;
  denominator: number;
  pending: number;
  censored: number;
  unknown: number;
  excluded: number;
}

export interface ObservabilityMetrics {
  window: { from: string; to: string };
  scope: { kind: "thread" | "system"; threadId: string | null };
  handoff: {
    completion: QualifiedRate;
    funnel: {
      attempted: number;
      accepted: number;
      enqueued: number;
      started: number;
      completed: number;
      losses: {
        duplicate: number;
        alreadyCompleted: number;
        rejected: number;
        notEnqueued: number;
        notStarted: number;
        executionFailed: number;
        aborted: number;
      };
    };
  };
  memory: {
    search: {
      availabilityRate: QualifiedRate;
      memoryHitRate: QualifiedRate;
      totalResultRate: QualifiedRate;
      averageMemoryHits: number | null;
      availability: Record<string, number>;
    };
    injection: {
      availabilityRate: QualifiedRate;
      coverageRate: QualifiedRate;
      averageDelivered: number | null;
      budgetDropRate: QualifiedRate;
      truncationRate: QualifiedRate;
      availability: Record<string, number>;
    };
    write: {
      calls: number;
      created: number;
      unchanged: number;
      superseded: number;
      rejected: number;
    };
    strictRecallAtK: (QualifiedRate & { cutoffK: number; mrr: number; ndcgAtK: number }) | null;
    usedRate?: QualifiedRate | null;
    correctRate?: QualifiedRate | null;
    businessSuccessRate?: QualifiedRate | null;
    completeness: "best_effort" | "incomplete" | "unknown";
    telemetry: Record<string, unknown> | null;
    semantics: string;
    applicability: { contractAppliedAt: string | null; historicalEventsExcluded: number };
  };
  comparison: {
    baselineWindow: { from: string; to: string };
    minSamples: number;
    dropThreshold: number;
    indicators: Array<{
      metric: "handoff.completion" | "memory.searchHitRate";
      state: "stable" | "regressed" | "unknown";
      delta: number | null;
      current: Pick<QualifiedRate, "value" | "numerator" | "denominator">;
      baseline: Pick<QualifiedRate, "value" | "numerator" | "denominator">;
    }>;
  };
}

export interface ObservabilityHealth {
  state: "available" | "degraded" | "unavailable";
  authoritativeViolations: number | null;
  alerts: Array<{
    code: string;
    severity: "error" | "warning";
    count?: number;
    value?: number;
    threshold?: number;
    lastOccurredAt?: string | null;
    diagnostic: { title: string; action: string };
  }>;
  checks: Record<string, number | null> | null;
}

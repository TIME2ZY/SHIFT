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
  handoff: {
    scheduling: QualifiedRate;
    execution: QualifiedRate;
    endToEnd: QualifiedRate;
  };
  memory: {
    hitRate: QualifiedRate;
    strictRecallAtK: (QualifiedRate & { cutoffK: number; mrr: number; ndcgAtK: number }) | null;
    usedRate?: QualifiedRate | null;
    correctRate?: QualifiedRate | null;
    businessSuccessRate?: QualifiedRate | null;
    semantics: string;
  };
}

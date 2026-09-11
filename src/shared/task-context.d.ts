/** Read-only API contract shared by task prompts, MCP and the web view. */
export interface TaskProgress {
  goal_hash: string;
  plan_hash: string | null;
  current: string;
  completed: { item: string; evidence: string[] }[];
  remaining: string[];
  blockers: string[];
  next_action: string;
  verification: string[];
  sourceInvocationId: string;
  seatId: string;
  duty: string;
  reportedAt: string;
  evidenceLevel: "agent_reported";
}

export interface TaskContext {
  threadId: string;
  version: number;
  updatedAt: string;
  originalGoal: string | null;
  currentGoal: { text: string; hash: string; messageId: string | null } | null;
  userUpdates: { messageId: string; text: string }[];
  requirements: {
    summary: string;
    constraints: string[];
    non_goals: string[];
    acceptance_criteria: string[];
    hash: string;
  } | null;
  plan: {
    summary: string;
    files: string[];
    changes: string[];
    tests: string[];
    risks: string[];
    hash: string;
  } | null;
  planApproval: { status: string; approvedPlanHash?: string | null } | null;
  status: string;
  phase: string;
  currentDuty: string | null;
  currentSeatId: string | null;
  progress: TaskProgress | null;
  review: { verdict: string; summary: string; findings: string[]; tests: string[] } | null;
  delivery: Record<string, unknown> | null;
  acceptance: Record<string, unknown> | null;
}

export interface RecoveryPacket {
  eventId: number;
  sealId: string | number;
  sourceInvocationId: string;
  content: string;
  createdAt: string;
  metadata: {
    agentId?: string;
    generation?: number;
    partial?: boolean;
    reason?: string;
    taskVersion?: number | null;
  };
  restorations: {
    invocationId: string;
    createdAt: string;
    stage: "prompt_prepared";
    taskVersion: number | null;
    promptHash: string;
    seals: { sealId: string | number; contentHash: string }[];
  }[];
}

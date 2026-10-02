export type DelegationState =
  "draft" | "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
export interface DelegationContract {
  workflowId: "software_delivery";
  goal: string;
  deliverables: string[];
  acceptanceCriteria: string[];
  subtasks: Array<{ id: string; title: string; description: string }>;
}
export interface DelegationTask {
  threadId: string;
  projectKey?: string;
  delegationState: DelegationState;
  version: number;
  contract: DelegationContract | null;
  contractHash: string | null;
  queueSeq: number | null;
  parentThreadId: string | null;
  delegationReason: string | null;
  executionTraceId: string | null;
  repairCount: number;
  subtaskProgress?: {
    blockers: string[];
    items: Array<{
      id: string;
      state: "accepted" | "reported_complete" | "in_progress" | "pending";
      evidence: string[];
    }>;
  };
  team: {
    members: Array<{
      seatId: string;
      providerId: string;
      label: string;
      availabilityStatus: string;
    }>;
    reviewMode: string;
  } | null;
  result: {
    summary: string;
    workspaceDir?: string;
    delivery: { commitSha?: string; prUrl?: string; ciStatus?: string } | null;
  } | null;
}
export declare const DELEGATION_STATES: readonly DelegationState[];
export declare const SOFTWARE_DUTIES: readonly string[];
export declare const DEFAULT_DELEGATION_POLICY: {
  readonly maxRepairs: number;
  readonly deadlineMs: number;
};
export declare function normalizeDelegationContract(value: unknown): DelegationContract;

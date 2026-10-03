export type DelegationState =
  "draft" | "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
export type NodeState = "pending" | "running" | "completed" | "failed" | "cancelled";
export interface PlanNode {
  id: string;
  title: string;
  description: string;
  workflowId: string;
  capabilities: string[];
  dependsOn: string[];
  deliverables: string[];
  acceptanceCriteria: string[];
}
export interface DelegationContract {
  goal: string;
  deliverables: string[];
  acceptanceCriteria: string[];
  subtasks: PlanNode[];
}
export interface TeamSelection {
  workflowId: string;
  members: Array<{ providerId: string; label: string; availabilityStatus: string }>;
  bindings: Record<string, { providerId: string; routingReason: string }>;
}
export interface TeamRun {
  id: string;
  nodeId: string;
  attempt: number;
  threadId: string | null;
  traceId: string | null;
  state: "running" | "completed" | "failed" | "cancelled";
  reason: string | null;
  team: TeamSelection;
  baseline: Record<string, unknown> | null;
  unknownSideEffect: boolean;
  startedAt: string;
  endedAt: string | null;
}
export interface TaskArtifact {
  id: string;
  runId: string;
  kind: string;
  locator: string;
  summary: string;
  contentHash: string | null;
  metadata: Record<string, unknown>;
}
export interface TaskAcceptance {
  runId: string;
  verdict: "accepted";
  evidenceLevel: "verified" | "agent_reviewed";
  artifactIds: string[];
  criteria: string[];
  evidence: Record<string, unknown>;
}
export interface DelegationTask {
  id: string;
  parentTaskId: string | null;
  projectKey: string | null;
  preparationThreadId: string | null;
  preparationMessage: { id: string; content: string } | null;
  revision: number;
  state: DelegationState;
  contract: DelegationContract | null;
  plan: { id: string; hash: string; sourceRevision: number; createdAt: string } | null;
  queueSeq: number | null;
  reason: string | null;
  deadlineAt: string | null;
  createdAt: string;
  updatedAt: string;
  nodes: Array<PlanNode & { state: NodeState; team: TeamSelection }>;
  runs: TeamRun[];
  artifacts: TaskArtifact[];
  acceptances: TaskAcceptance[];
  legacySource: { threadId: string; result: unknown } | null;
}
export declare const DELEGATION_STATES: readonly DelegationState[];
export declare const NODE_STATES: readonly NodeState[];
export declare const DEFAULT_DELEGATION_POLICY: {
  readonly maxRepairs: number;
  readonly deadlineMs: number;
};
export declare function normalizeDelegationContract(value: unknown): DelegationContract;

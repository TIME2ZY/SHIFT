export interface CollaborationImplementation {
  status: "required" | "pending_approval" | "approved" | null;
  allowed: boolean | null;
  reason: string | null;
  planHash: string | null;
  summary: string | null;
}

export interface CollaborationReview {
  status: "approved" | "changes_requested" | string | null;
  verdict: string | null;
}

export interface CollaborationDelivery {
  status: "verified" | "recorded" | null;
  commitSha: string | null;
  prUrl: string | null;
  ciStatus: string | null;
}

export interface CollaborationAcceptance {
  status: "accepted" | "rejected" | "recorded" | null;
  verdict: string | null;
}

export interface CollaborationSnapshot {
  phase: "discuss" | "implement" | "review" | "deliver" | "done" | string;
  goal: string | null;
  lastFrom: string | null;
  lastTo: string | null;
  updatedAt: string | null;
  implementation: CollaborationImplementation;
  review: CollaborationReview;
  delivery: CollaborationDelivery;
  acceptance: CollaborationAcceptance;
  blocker: string | null;
}

export interface CollaborationResponse {
  collaboration: CollaborationSnapshot | null;
}

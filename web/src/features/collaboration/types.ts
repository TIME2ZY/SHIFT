export interface CollaborationSeat {
  seatId: string;
  providerId: string | null;
  label: string | null;
}

export interface CollaborationBlocker {
  type:
    | "waiting_human"
    | "waiting_approval"
    | "missing_evidence"
    | "provider_unavailable"
    | "execution_failed";
  reason: string;
}

export interface CollaborationEvidence {
  dirtyFileCount: number | null;
  headSha: string | null;
  commitSha: string | null;
  prUrl: string | null;
  ciStatus: string | null;
}

export interface CollaborationSnapshot {
  status: "active" | "waiting_human" | "accepted" | "rejected" | string;
  phase: "discuss" | "implement" | "review" | "deliver" | "done" | string;
  goalOriginal: string | null;
  goalNormalized: string | null;
  currentSeat: CollaborationSeat | null;
  currentDuty: string | null;
  currentSkill: string | null;
  enforcementLevel: "enforced" | "advisory" | string | null;
  updatedAt: string | null;
  blocker: CollaborationBlocker | null;
  evidence: CollaborationEvidence;
  reviewMode: "same_seat" | "other_seat" | "pending";
  nextAction: string;
}

export interface CollaborationResponse {
  collaboration: CollaborationSnapshot | null;
  seats: CollaborationSeat[];
}

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CollaborationStatus } from "./CollaborationStatus";
import type { CollaborationSnapshot } from "./types";

function snapshot(overrides: Partial<CollaborationSnapshot> = {}): CollaborationSnapshot {
  return {
    phase: "discuss",
    goal: null,
    lastFrom: null,
    lastTo: null,
    updatedAt: null,
    implementation: {
      status: null,
      allowed: null,
      reason: null,
      planHash: null,
      summary: null,
    },
    review: { status: null, verdict: null },
    delivery: { status: null, commitSha: null, prUrl: null, ciStatus: null },
    acceptance: { status: null, verdict: null },
    blocker: null,
    ...overrides,
  };
}

describe("CollaborationStatus", () => {
  it("shows an empty collaboration state", () => {
    render(<CollaborationStatus snapshot={null} loading={false} error={null} />);
    expect(screen.getByRole("region", { name: "协作状态" })).toBeInTheDocument();
    expect(screen.getByText("尚未开始协作。")).toBeInTheDocument();
  });

  it("renders a pending plan as the current blocker", () => {
    render(
      <CollaborationStatus
        loading={false}
        error={null}
        snapshot={snapshot({
          phase: "implement",
          goal: "Fix utcOffset clone",
          implementation: {
            status: "pending_approval",
            allowed: false,
            reason: "implementation_plan_not_approved",
            planHash: "plan-1",
            summary: "Clone first",
          },
          blocker: "implementation_plan_not_approved",
        })}
      />
    );
    expect(screen.getByText("实现")).toBeInTheDocument();
    expect(screen.getByText("待 Codex 批准")).toBeInTheDocument();
    expect(screen.getByText("等待 Codex 批准方案")).toBeInTheDocument();
    expect(screen.getByText("Fix utcOffset clone")).toBeInTheDocument();
  });
});

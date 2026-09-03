import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CollaborationStatus } from "./CollaborationStatus";
import type { CollaborationSnapshot } from "./types";

function snapshot(overrides: Partial<CollaborationSnapshot> = {}): CollaborationSnapshot {
  return {
    status: "active",
    phase: "discuss",
    goalOriginal: null,
    goalNormalized: null,
    currentSeat: null,
    currentDuty: null,
    currentSkill: null,
    enforcementLevel: null,
    updatedAt: null,
    blocker: null,
    evidence: { dirtyFileCount: null, headSha: null, commitSha: null, prUrl: null, ciStatus: null },
    reviewMode: "pending",
    nextAction: "继续推进当前目标。",
    ...overrides,
  };
}

describe("CollaborationStatus", () => {
  it("shows an empty collaboration state", () => {
    render(<CollaborationStatus snapshot={null} loading={false} error={null} />);
    expect(screen.getByRole("region", { name: "任务卡" })).toBeInTheDocument();
    expect(screen.getByText("发送消息后，这里会显示目标与完成证据。")).toBeInTheDocument();
  });

  it("renders a pending plan as the current blocker", () => {
    render(
      <CollaborationStatus
        loading={false}
        error={null}
        snapshot={snapshot({
          phase: "implement",
          goalOriginal: "Fix utcOffset clone",
          goalNormalized: "Clone first",
          currentSeat: { seatId: "seat-grok", providerId: "grok", label: "实现席" },
          currentDuty: "implement",
          currentSkill: "implementation-plan",
          blocker: {
            type: "waiting_approval",
            reason: "implementation_plan_not_approved",
          },
          evidence: {
            dirtyFileCount: 2,
            headSha: "abcdef123456",
            commitSha: null,
            prUrl: null,
            ciStatus: null,
          },
          nextAction: "请批准实现方案后继续。",
        })}
      />
    );
    expect(screen.getByText("实现席")).toBeInTheDocument();
    expect(screen.getByText("实现 · implementation-plan")).toBeInTheDocument();
    expect(screen.getByText("等待批准实现方案")).toBeInTheDocument();
    expect(screen.getByText("Fix utcOffset clone")).toBeInTheDocument();
    expect(screen.getByText("Clone first")).toBeInTheDocument();
    expect(screen.getByText("abcdef1")).toBeInTheDocument();
    expect(screen.getByText("请批准实现方案后继续。")).toBeInTheDocument();
  });
});

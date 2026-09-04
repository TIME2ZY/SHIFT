import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
    acceptance: {
      evidenceProfile: "code_change",
      goalHash: null,
      planHash: null,
      branch: null,
      headSha: null,
      commitSha: null,
      prUrl: null,
      ciStatus: "unknown",
      reviewMode: "pending",
      reviewVerdict: "unknown",
      verdict: "incomplete",
      ready: false,
      reason: "human_acceptance_required",
      decidedAt: null,
    },
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

  it("shows unknown delivery facts, self-review, and records Human acceptance", async () => {
    const onDecision = vi.fn(async () => undefined);
    render(
      <CollaborationStatus
        loading={false}
        error={null}
        onAcceptanceDecision={onDecision}
        snapshot={snapshot({
          status: "waiting_human",
          phase: "deliver",
          reviewMode: "same_seat",
          acceptance: {
            ...snapshot().acceptance,
            goalHash: "1234567890abcdef",
            planHash: "abcdef1234567890",
            reviewMode: "same_seat",
            reviewVerdict: "approved",
            ready: true,
          },
        })}
      />
    );

    const card = screen.getByRole("region", { name: "验收卡" });
    expect(card).toHaveTextContent("1234567890ab");
    expect(card).toHaveTextContent("当前席位自审");
    expect(card).toHaveTextContent("unknown");
    await userEvent.click(screen.getByRole("button", { name: "对照目标验收" }));
    await userEvent.type(screen.getByRole("textbox", { name: "验收说明（可选）" }), "目标已满足");
    await userEvent.click(screen.getByRole("button", { name: "确认验收" }));
    expect(onDecision).toHaveBeenCalledWith("accepted", "目标已满足");
  });

  it("shows a rejected Human verdict explicitly", () => {
    render(
      <CollaborationStatus
        loading={false}
        error={null}
        snapshot={snapshot({
          status: "rejected",
          acceptance: {
            ...snapshot().acceptance,
            verdict: "rejected",
            reason: "human_rejected",
          },
        })}
      />
    );
    expect(screen.getByRole("region", { name: "验收卡" })).toHaveTextContent("已拒绝");
    expect(screen.getByText("用户已拒绝本次交付。")).toBeInTheDocument();
  });
});

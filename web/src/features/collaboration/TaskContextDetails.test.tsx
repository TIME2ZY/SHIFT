import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { TaskContextDetails } from "./TaskContextDetails";
import type { TaskContext, RecoveryPacket } from "../../../../src/shared/task-context";

it("expands the durable plan and distinguishes reported progress from acceptance", async () => {
  const task: TaskContext = {
    threadId: "thread",
    version: 4,
    updatedAt: "2026-09-11",
    originalGoal: "原始目标",
    currentGoal: { text: "当前目标", hash: "goal", messageId: "message" },
    userUpdates: [],
    requirements: {
      summary: "需求理解",
      constraints: ["保持接口"],
      non_goals: [],
      acceptance_criteria: ["重启可恢复"],
      hash: "requirements",
    },
    plan: {
      summary: "执行方案",
      files: ["src/session/bootstrap.js"],
      changes: ["注入当前状态"],
      tests: ["恢复测试"],
      risks: [],
      hash: "plan",
    },
    planApproval: { status: "approved", approvedPlanHash: "plan" },
    status: "active",
    phase: "implement",
    currentDuty: "implement",
    currentSeatId: "seat",
    progress: {
      goal_hash: "goal",
      plan_hash: "plan",
      current: "等待回归",
      completed: [{ item: "持久化", evidence: ["commit abc"] }],
      remaining: ["浏览器验证"],
      blockers: ["测试失败"],
      next_action: "修复回归",
      verification: ["单测通过"],
      sourceInvocationId: "invocation",
      seatId: "seat",
      duty: "implement",
      reportedAt: "2026-09-11",
      evidenceLevel: "agent_reported",
    },
    review: null,
    delivery: null,
    acceptance: null,
  };
  render(<TaskContextDetails task={task} />);
  expect(screen.getByText("执行方案").closest("details")).not.toHaveAttribute("open");
  await userEvent.click(screen.getByText("需求与计划"));
  expect(screen.getByText("执行方案")).toBeVisible();
  expect(screen.getByText("重启可恢复")).toBeVisible();
  expect(screen.getByText("计划已通过证据门禁")).toBeVisible();
  expect(screen.getByText("Agent 报告 · 不代表最终验收")).toBeVisible();
  expect(screen.getByText("持久化 — commit abc")).toBeVisible();
  expect(screen.getByText("修复回归")).toBeVisible();
});

it("shows packet contents and only claims restoration when prompt preparation is recorded", async () => {
  const packet: RecoveryPacket = {
    eventId: 1,
    sealId: "seal",
    sourceInvocationId: "old",
    content: "next_action: 修复回归",
    createdAt: "2026-09-11",
    metadata: { agentId: "codex", generation: 1, partial: true },
    restorations: [],
  };
  const { rerender } = render(<TaskContextDetails recovery={[packet]} />);
  await userEvent.click(screen.getByText("上下文续接"));
  await userEvent.click(screen.getByText(/未记录后续注入/));
  expect(screen.getByLabelText("续工包内容")).toBeVisible();
  expect(screen.queryByText(/已加入调用/)).not.toBeInTheDocument();
  rerender(
    <TaskContextDetails
      recovery={[
        {
          ...packet,
          restorations: [
            {
              invocationId: "new",
              createdAt: "2026-09-11",
              stage: "prompt_prepared",
              taskVersion: 4,
              promptHash: "hash",
              seals: [{ sealId: "seal", contentHash: "content" }],
            },
          ],
        },
      ]}
    />
  );
  expect(screen.getByText(/已加入后续调用/)).toBeVisible();
  expect(screen.getByText(/表示输入已准备，不代表模型已理解或任务已完成/)).toBeVisible();
});

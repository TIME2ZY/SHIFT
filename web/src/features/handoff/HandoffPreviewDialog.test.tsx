import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HandoffPreviewDialog } from "./HandoffPreviewDialog";

const preview = {
  previewId: "preview-1",
  threadId: "session-1",
  sourceInvocationId: "invocation-1",
  createdAt: "2026-09-04T00:00:00.000Z",
  expiresAt: "2026-09-04T00:10:00.000Z",
  summary: {
    goal: "完成任务卡",
    completed: "已完成读模型",
    constraints: ["SQLite 是真相源"],
    files: ["src/server/session-routes.js"],
    openQuestions: [],
    prohibited: ["不要增加第二条队列"],
    nextAction: "审查实现",
    targetSeat: { seatId: "seat-gemini", providerId: "gemini", label: "审查席" },
    duty: "review",
    skillName: "code-review-deliver",
    degraded: false,
    missing: [],
  },
};

describe("HandoffPreviewDialog", () => {
  it("lets the user edit a constraint before confirming", async () => {
    const onConfirm = vi.fn(async () => undefined);
    render(
      <HandoffPreviewDialog
        preview={preview}
        onConfirm={onConfirm}
        onCancel={async () => undefined}
      />
    );

    expect(screen.getByRole("dialog", { name: "确认任务交接" })).toBeInTheDocument();
    expect(screen.getByText("审查席")).toBeInTheDocument();
    const constraints = screen.getByRole("textbox", { name: "约束（每行一项）" });
    await userEvent.clear(constraints);
    await userEvent.type(constraints, "SQLite 与 Git 是真相源");
    await userEvent.click(screen.getByRole("button", { name: "确认并交接" }));

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ constraints: ["SQLite 与 Git 是真相源"] })
    );
  });

  it("cancels without confirming", async () => {
    const onCancel = vi.fn(async () => undefined);
    render(
      <HandoffPreviewDialog
        preview={preview}
        onConfirm={async () => undefined}
        onCancel={onCancel}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "取消交接" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

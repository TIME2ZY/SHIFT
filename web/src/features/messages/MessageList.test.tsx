import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MessageList } from "./MessageList";

describe("MessageList", () => {
  it("renders persisted and live messages in the same transcript", () => {
    render(
      <MessageList
        messages={[{ id: "m1", role: "user", content: "开始" }]}
        agents={[{ id: "codex", label: "Codex" }]}
        run={{
          sessionId: "s1",
          status: "running",
          updatedAt: 1,
          doneReceived: false,
          liveMessages: {
            codex: {
              agentId: "codex",
              text: "实时回答",
              status: "streaming",
            },
          },
          invocations: {},
          notices: [],
        }}
        isLoading={false}
        error={null}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByText("开始")).toBeInTheDocument();
    expect(screen.getByText("实时回答")).toBeInTheDocument();
    expect(screen.getByText("输出中")).toBeInTheDocument();
    expect(screen.getByTitle("你")).toBeInTheDocument();
    expect(screen.getByTitle("Codex")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "会话消息导航" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "跳到第 1 条你消息" })).toBeInTheDocument();
  });

  it("moves to the selected conversation bubble", async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    render(
      <MessageList
        messages={[
          { id: "m1", role: "user", content: "请检查界面" },
          { id: "m2", role: "assistant", agentId: "gemini", content: "检查完成" },
        ]}
        agents={[{ id: "gemini", label: "Gemini" }]}
        run={null}
        isLoading={false}
        error={null}
        onRetry={vi.fn()}
      />
    );

    const userBubble = screen.getByRole("button", { name: "跳到第 1 条你消息" });
    await user.click(userBubble);

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(userBubble).toHaveAttribute("aria-current", "location");
  });
});

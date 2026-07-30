import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageList } from "./MessageList";

describe("MessageList", () => {
  it("renders persisted and live messages in the same transcript", () => {
    render(
      <MessageList
        messages={[{ id: "m1", role: "user", content: "开始" }]}
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
  });
});

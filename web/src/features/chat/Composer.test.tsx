import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

describe("Composer", () => {
  it("sends a trimmed prompt and clears the draft", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(
      <Composer
        sessionId="s1"
        agents={[{ id: "codex", label: "Codex" }]}
        selectedAgentId="codex"
        running={false}
        onSend={onSend}
        onStop={vi.fn()}
      />
    );

    const input = screen.getByRole("textbox", { name: "消息" });
    await userEvent.type(input, "  hello  ");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(onSend).toHaveBeenCalledWith("hello", false);
    expect(input).toHaveValue("");
  });

  it("shows the stop action while a run is active", async () => {
    const onStop = vi.fn();
    render(
      <Composer
        sessionId="s1"
        agents={[{ id: "codex", label: "Codex" }]}
        selectedAgentId="codex"
        running
        onSend={vi.fn()}
        onStop={onStop}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("sends in worktree mode only after the user enables code changes", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(
      <Composer
        sessionId="s1"
        agents={[{ id: "codex", label: "Codex" }]}
        selectedAgentId="codex"
        running={false}
        onSend={onSend}
        onStop={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole("checkbox", { name: "隔离改代码" }));
    expect(screen.getByText("将在隔离 worktree 中运行")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "implement this");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(onSend).toHaveBeenCalledWith("implement this", true);
  });

  it("keeps drafts isolated when switching sessions", async () => {
    const props = {
      agents: [{ id: "codex", label: "Codex" }],
      selectedAgentId: "codex",
      running: false,
      onSend: vi.fn(),
      onStop: vi.fn(),
    };
    const { rerender } = render(<Composer {...props} sessionId="s1" />);
    const input = screen.getByRole("textbox", { name: "消息" });
    await userEvent.type(input, "session one");

    rerender(<Composer {...props} sessionId="s2" />);
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("");
    await userEvent.type(screen.getByRole("textbox", { name: "消息" }), "session two");

    rerender(<Composer {...props} sessionId="s1" />);
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("session one");
  });

  it("offers @Agent completion without changing the default target", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(
      <Composer
        sessionId="s1"
        agents={[
          { id: "codex", label: "Codex" },
          { id: "gemini", label: "Gemini" },
        ]}
        selectedAgentId="codex"
        running={false}
        onSend={onSend}
        onStop={vi.fn()}
      />
    );

    const input = screen.getByRole("textbox", { name: "消息" });
    await userEvent.type(input, "@gem");
    expect(screen.getByRole("listbox", { name: "选择消息目标 Agent" })).toHaveTextContent("Gemini");
    await userEvent.keyboard("{Enter}");
    expect(input).toHaveValue("@Gemini ");
    await userEvent.type(input, "review this");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(onSend).toHaveBeenCalledWith("@Gemini review this", false);
  });
});

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

  it("applies an external draft seed into the textarea and focuses it", async () => {
    const onDraftSeedApplied = vi.fn();
    const { rerender } = render(
      <Composer
        sessionId="s1"
        agents={[{ id: "codex", label: "Codex" }]}
        selectedAgentId="codex"
        running={false}
        draftSeed={{ id: 1, text: "  请审查前端 UI  " }}
        onDraftSeedApplied={onDraftSeedApplied}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />
    );

    const input = screen.getByRole("textbox", { name: "消息" });
    expect(input).toHaveValue("请审查前端 UI");
    expect(onDraftSeedApplied).toHaveBeenCalledOnce();

    rerender(
      <Composer
        sessionId="s1"
        agents={[{ id: "codex", label: "Codex" }]}
        selectedAgentId="codex"
        running={false}
        draftSeed={{ id: 2, text: "第二段推荐提示" }}
        onDraftSeedApplied={onDraftSeedApplied}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />
    );
    expect(input).toHaveValue("第二段推荐提示");
    expect(onDraftSeedApplied).toHaveBeenCalledTimes(2);
  });

  it("enables worktree mode only when an external draft seed explicitly requests it", async () => {
    const props = {
      sessionId: "s1",
      agents: [{ id: "codex", label: "Codex" }],
      selectedAgentId: "codex",
      running: false,
      onDraftSeedApplied: vi.fn(),
      onSend: vi.fn(),
      onStop: vi.fn(),
    };
    const { rerender } = render(
      <Composer {...props} draftSeed={{ id: 1, text: "普通推荐提示" }} />
    );
    const toggle = screen.getByRole("checkbox", { name: "隔离改代码" });
    expect(toggle).not.toBeChecked();

    rerender(
      <Composer
        {...props}
        draftSeed={{ id: 2, text: "重构推荐提示", useWorktree: true }}
      />
    );
    expect(toggle).toBeChecked();

    rerender(<Composer {...props} draftSeed={{ id: 3, text: "另一个普通推荐提示" }} />);
    expect(toggle).toBeChecked();
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

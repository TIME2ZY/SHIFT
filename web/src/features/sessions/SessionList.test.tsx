import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SessionList } from "./SessionList";

describe("SessionList", () => {
  it("selects a session using its stable id", async () => {
    const onSelect = vi.fn();
    render(
      <SessionList
        sessions={[
          { id: "s1", title: "第一轮", lastAgent: "codex" },
          { id: "s2", title: "第二轮" },
        ]}
        activeSessionId="s1"
        isLoading={false}
        error={null}
        onSelect={onSelect}
        onRetry={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "第二轮" }));
    expect(onSelect).toHaveBeenCalledWith("s2");
  });

  it("exposes create and delete actions without selecting the row", async () => {
    const onCreate = vi.fn();
    const onDelete = vi.fn();
    const onSelect = vi.fn();
    render(
      <SessionList
        sessions={[{ id: "s1", title: "第一轮" }]}
        activeSessionId="s1"
        isLoading={false}
        error={null}
        onCreate={onCreate}
        onDelete={onDelete}
        onSelect={onSelect}
        onRetry={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "新建对话" }));
    await userEvent.click(screen.getByRole("button", { name: "删除对话 第一轮" }));

    expect(onCreate).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledWith("s1");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("filters sessions by title or Agent", async () => {
    render(
      <SessionList
        sessions={[
          { id: "s1", title: "前端重构", lastAgent: "codex" },
          { id: "s2", title: "存储审计", lastAgent: "gemini" },
        ]}
        activeSessionId="s1"
        isLoading={false}
        error={null}
        onSelect={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    await userEvent.type(screen.getByRole("searchbox", { name: "搜索会话" }), "gemini");
    expect(screen.queryByText("前端重构")).not.toBeInTheDocument();
    expect(screen.getByText("存储审计")).toBeInTheDocument();
  });

  it("shows one consistent label for an empty session title", () => {
    render(
      <SessionList
        sessions={[{ id: "opaque-session-id", title: "" }]}
        activeSessionId="opaque-session-id"
        isLoading={false}
        error={null}
        onSelect={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "(空对话)" })).toBeInTheDocument();
    expect(screen.queryByText("opaque-session-id")).not.toBeInTheDocument();
  });
});

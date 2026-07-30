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
});

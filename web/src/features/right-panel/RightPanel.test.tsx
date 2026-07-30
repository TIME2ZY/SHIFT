import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RightPanel } from "./RightPanel";

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <RightPanel
        sessionId="session-1"
        agents={[
          {
            id: "codex",
            label: "Codex",
            description: "负责实现与验证。",
          },
        ]}
      />
    </QueryClientProvider>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RightPanel", () => {
  it("shows agents without loading inactive remote panels", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderPanel();

    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("负责实现与验证。")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads active memories on demand", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          memories: [
            {
              id: "memory-1",
              kind: "decision",
              topic: "前端架构",
              content: "使用 React 和 TanStack Query。",
              status: "active",
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    renderPanel();
    await userEvent.click(screen.getByRole("tab", { name: "记忆" }));

    expect(await screen.findByText("前端架构")).toBeInTheDocument();
    expect(screen.getByText("使用 React 和 TanStack Query。")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/memories?sessionId=session-1&includeRetired=0&limit=50",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("does not request a missing worktree status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ dir: "C:/workspace" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    renderPanel();
    await userEvent.click(screen.getByRole("tab", { name: "工作区" }));

    expect(await screen.findByText("C:/workspace")).toBeInTheDocument();
    expect(
      screen.getByText("尚未创建隔离工作区。发送消息前开启「改代码」即可创建。")
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/project?sessionId=session-1",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("updates the session project directory", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/project" && init?.method === "POST") {
        return Promise.resolve(
          new Response(JSON.stringify({ dir: "D:/next-project" }), { status: 200 })
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ dir: "D:/next-project" }), { status: 200 })
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPanel();
    await userEvent.click(screen.getByRole("tab", { name: "工作区" }));
    await screen.findByText("D:/next-project");
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));

    const input = screen.getByRole("textbox", { name: "项目目录" });
    await userEvent.clear(input);
    await userEvent.type(input, "D:/updated-project");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/project",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          sessionId: "session-1",
          dir: "D:/updated-project",
        }),
      })
    );
  });
});

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
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Agent",
      "记忆",
      "Recall",
    ]);
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
});

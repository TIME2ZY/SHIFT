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
        selectedAgentId="codex"
        run={null}
        open={false}
        onClose={() => undefined}
        onAgentChange={() => undefined}
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
  it("changes the current Agent from the Agent panel", async () => {
    const onAgentChange = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ available: false, session: {}, agents: [] }))
        )
    );
    render(
      <QueryClientProvider client={queryClient}>
        <RightPanel
          sessionId="session-1"
          selectedAgentId="codex"
          run={null}
          open={false}
          onClose={() => undefined}
          onAgentChange={onAgentChange}
          agents={[
            { id: "codex", label: "Codex" },
            { id: "gemini", label: "Gemini" },
          ]}
        />
      </QueryClientProvider>
    );

    await userEvent.click(screen.getByRole("radio", { name: /Gemini/ }));
    expect(onAgentChange).toHaveBeenCalledWith("gemini");
  });

  it("shows per-agent usage without loading inactive memories", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          available: true,
          session: { totalTokens: 2400 },
          agents: [
            {
              agentId: "codex",
              billing: { inputTokens: 1200, outputTokens: 1200, totalTokens: 2400 },
              context: {
                usableContextTokens: 200000,
                contextUsedTokens: 80000,
                budgetFillRatio: 0.4,
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    renderPanel();

    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("负责实现与验证。")).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByText("Agent")).toBeInTheDocument();

    expect(screen.queryByText("当前团队")).not.toBeInTheDocument();
    expect(await screen.findByText("2.4k tokens")).toBeInTheDocument();
    expect(screen.getByText("40% · 充足")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

});

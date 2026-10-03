import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
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
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.includes("/collaboration")) {
          return new Response(
            JSON.stringify({
              collaboration: null,
              seats: [
                { seatId: "seat-codex", providerId: "codex", label: null },
                { seatId: "seat-gemini", providerId: "gemini", label: null },
              ],
            })
          );
        }
        return new Response(JSON.stringify({ available: false, session: {}, agents: [] }));
      })
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
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes("/collaboration")) {
        return new Response(
          JSON.stringify({
            collaboration: null,
            seats: [{ seatId: "seat-codex", providerId: "codex", label: null }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      }
      return new Response(
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
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPanel();

    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("负责实现与验证。")).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByText("席位")).toBeInTheDocument();

    expect(screen.queryByText("当前团队")).not.toBeInTheDocument();
    expect(await screen.findByText("2.4k tokens")).toBeInTheDocument();
    expect(screen.getByText("40% · 充足")).toBeInTheDocument();
    expect(await screen.findByText("发送消息后，这里会显示目标与完成证据。")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("moves seat selection with arrow keys and keeps one tab stop", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.includes("/collaboration")) {
          return new Response(
            JSON.stringify({
              collaboration: null,
              seats: [
                { seatId: "seat-codex", providerId: "codex", label: null },
                { seatId: "seat-gemini", providerId: "gemini", label: null },
              ],
            })
          );
        }
        return new Response(JSON.stringify({ available: false, session: {}, agents: [] }));
      })
    );

    // Selection lives in the parent, as it does in App: arrows must move both
    // the choice and the focus, not just fire a callback.
    function SeatSwitcher() {
      const [selected, setSelected] = useState("codex");
      return (
        <QueryClientProvider client={queryClient}>
          <RightPanel
            sessionId="session-1"
            selectedAgentId={selected}
            run={null}
            open={false}
            onClose={() => undefined}
            onAgentChange={setSelected}
            agents={[
              { id: "codex", label: "Codex" },
              { id: "gemini", label: "Gemini" },
            ]}
          />
        </QueryClientProvider>
      );
    }
    render(<SeatSwitcher />);

    const codex = await screen.findByRole("radio", { name: /Codex/ });
    const gemini = screen.getByRole("radio", { name: /Gemini/ });

    // Roving tabindex: only the selected seat holds the tab stop.
    expect(codex).toHaveAttribute("tabindex", "0");
    expect(gemini).toHaveAttribute("tabindex", "-1");

    codex.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(gemini).toHaveAttribute("aria-checked", "true");
    expect(gemini).toHaveFocus();

    await userEvent.keyboard("{ArrowUp}");
    expect(codex).toHaveAttribute("aria-checked", "true");
    expect(codex).toHaveFocus();
  });

  it("does not move seat selection when the refresh button is focused", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.includes("/collaboration")) {
          return new Response(
            JSON.stringify({
              collaboration: null,
              seats: [
                { seatId: "seat-codex", providerId: "codex", label: null },
                { seatId: "seat-gemini", providerId: "gemini", label: null },
              ],
            })
          );
        }
        return new Response(JSON.stringify({ available: false, session: {}, agents: [] }));
      })
    );

    function SeatSwitcher() {
      const [selected, setSelected] = useState("codex");
      return (
        <QueryClientProvider client={queryClient}>
          <RightPanel
            sessionId="session-1"
            selectedAgentId={selected}
            run={null}
            open={false}
            onClose={() => undefined}
            onAgentChange={setSelected}
            agents={[
              {
                id: "codex",
                label: "Codex",
                availability: {
                  providerId: "codex",
                  status: "available",
                  reason: null,
                  checking: false,
                  observedAt: null,
                },
              },
              {
                id: "gemini",
                label: "Gemini",
                availability: {
                  providerId: "gemini",
                  status: "available",
                  reason: null,
                  checking: false,
                  observedAt: null,
                },
              },
            ]}
          />
        </QueryClientProvider>
      );
    }
    render(<SeatSwitcher />);

    const refresh = await screen.findByRole("button", { name: "重新检测 Codex" });
    refresh.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: /Codex/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /Gemini/ })).toHaveAttribute("aria-checked", "false");
  });

  it("starts arrow movement at the first selectable seat when selection is stale", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.includes("/collaboration")) {
          return new Response(
            JSON.stringify({
              collaboration: null,
              seats: [
                { seatId: "seat-codex", providerId: "codex", label: null },
                { seatId: "seat-gemini", providerId: "gemini", label: null },
                { seatId: "seat-grok", providerId: "grok", label: null },
              ],
            })
          );
        }
        return new Response(JSON.stringify({ available: false, session: {}, agents: [] }));
      })
    );

    function SeatSwitcher() {
      const [selected, setSelected] = useState("codex");
      return (
        <QueryClientProvider client={queryClient}>
          <RightPanel
            sessionId="session-1"
            selectedAgentId={selected}
            run={null}
            open={false}
            onClose={() => undefined}
            onAgentChange={setSelected}
            agents={[
              { id: "codex", label: "Codex", routable: false },
              { id: "gemini", label: "Gemini" },
              { id: "grok", label: "Grok" },
            ]}
          />
        </QueryClientProvider>
      );
    }
    render(<SeatSwitcher />);

    const gemini = await screen.findByRole("radio", { name: /Gemini/ });
    gemini.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(gemini).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /Grok/ })).toHaveAttribute("aria-checked", "false");
  });

  it("shows the pending implementation plan from the collaboration snapshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.includes("/collaboration")) {
          return new Response(
            JSON.stringify({
              collaboration: {
                status: "active",
                phase: "implement",
                goalOriginal: "Fix utcOffset clone",
                goalNormalized: "Clone first",
                currentSeat: {
                  seatId: "seat-grok",
                  providerId: "grok",
                  label: "实现席",
                },
                currentDuty: "implement",
                currentSkill: "implementation-plan",
                enforcementLevel: "advisory",
                updatedAt: "2026-08-27T00:00:00.000Z",
                blocker: {
                  type: "waiting_approval",
                  reason: "implementation_plan_not_approved",
                },
                evidence: {
                  dirtyFileCount: 1,
                  headSha: "a".repeat(40),
                  commitSha: null,
                  prUrl: null,
                  ciStatus: null,
                },
                reviewMode: "pending",
                acceptance: {
                  evidenceProfile: "code_change",
                  goalHash: null,
                  planHash: "plan-1",
                  branch: null,
                  headSha: "a".repeat(40),
                  commitSha: null,
                  prUrl: null,
                  ciStatus: "unknown",
                  reviewMode: "pending",
                  reviewVerdict: "unknown",
                  verdict: "incomplete",
                  ready: false,
                  reason: "implementation_plan_not_approved",
                  decidedAt: null,
                },
                nextAction: "请由讨论或验收席位批准方案后继续。",
              },
              seats: [{ seatId: "seat-codex", providerId: "codex", label: null }],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ available: false, session: {}, agents: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      })
    );

    renderPanel();
    expect(await screen.findByText("等待讨论席位批准方案")).toBeInTheDocument();
    expect(screen.getByText("实现 · implementation-plan")).toBeInTheDocument();
  });
});

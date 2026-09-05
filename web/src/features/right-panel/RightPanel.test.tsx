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

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compactTokens, UsageSummaryBadge } from "./UsageSummaryBadge";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UsageSummaryBadge", () => {
  it("formats compact token values", () => {
    expect(compactTokens(999)).toBe("999");
    expect(compactTokens(2_400)).toBe("2.4k");
    expect(compactTokens(2_300_000)).toBe("2.3M");
  });

  it("shows session billing and the selected agent context ratio", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            available: true,
            session: { totalTokens: 2400 },
            agents: [
              {
                agentId: "gemini",
                billing: { totalTokens: 2400 },
                context: {
                  usableContextTokens: 800000,
                  contextUsedTokens: 200000,
                  budgetFillRatio: 0.25,
                },
              },
            ],
          }),
          { status: 200 }
        )
      )
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <UsageSummaryBadge sessionId="session-1" agentId="gemini" />
      </QueryClientProvider>
    );

    expect(await screen.findByText("会话 2.4k")).toBeInTheDocument();
    expect(screen.getByText("上下文 25%")).toBeInTheDocument();
  });
});

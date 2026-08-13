import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TraceExplorer } from "./TraceExplorer";
import type { TraceSummary } from "./types";

const base = {
  threadId: "s1",
  clientTurnId: "turn-1",
  requestAttempt: 1,
  startedAt: "2026-08-13T00:00:00.000Z",
  endedAt: "2026-08-13T00:00:01.000Z",
  rootInvocationId: "i1",
  invocationCounts: { total: 1, failed: 0 },
  handoffCounts: { total: 0, accepted: 0, failed: 0 },
  handoffs: [],
};

describe("TraceExplorer", () => {
  it("shows agent routes and switches to a failed breakpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/api/storage/health")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                storage: {
                  observability: {
                    state: "degraded",
                    authoritativeViolations: 0,
                    checks: {},
                    alerts: [
                      {
                        code: "span_missing_end",
                        severity: "warning",
                        count: 1,
                        diagnostic: {
                          title: "执行区段缺少结束事件",
                          action: "按 Trace 的 incomplete span 定位 tool 或 generation。",
                        },
                      },
                    ],
                  },
                },
              })
            )
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              metrics: {
                window: { from: base.startedAt, to: base.endedAt },
                handoff: {
                  scheduling: {
                    value: 0.5,
                    numerator: 1,
                    denominator: 2,
                    pending: 1,
                    censored: 0,
                    unknown: 0,
                    excluded: 0,
                  },
                  execution: {
                    value: 1,
                    numerator: 2,
                    denominator: 2,
                    pending: 1,
                    censored: 0,
                    unknown: 0,
                    excluded: 0,
                  },
                  endToEnd: {
                    value: 0.5,
                    numerator: 1,
                    denominator: 2,
                    pending: 1,
                    censored: 0,
                    unknown: 0,
                    excluded: 0,
                  },
                },
                memory: {
                  hitRate: {
                    value: 0.5,
                    numerator: 1,
                    denominator: 2,
                    pending: 0,
                    censored: 0,
                    unknown: 1,
                    excluded: 0,
                  },
                  strictRecallAtK: null,
                  semantics: "hit rate",
                },
                comparison: {
                  baselineWindow: { from: base.startedAt, to: base.endedAt },
                  minSamples: 5,
                  dropThreshold: 0.1,
                  indicators: [
                    {
                      metric: "handoff.endToEnd",
                      state: "regressed",
                      delta: -0.25,
                      current: { value: 0.5, numerator: 1, denominator: 2 },
                      baseline: { value: 0.75, numerator: 3, denominator: 4 },
                    },
                    {
                      metric: "memory.hitRate",
                      state: "unknown",
                      delta: null,
                      current: { value: 0.5, numerator: 1, denominator: 2 },
                      baseline: { value: null, numerator: 0, denominator: 0 },
                    },
                  ],
                },
              },
            })
          )
        );
      })
    );
    const traces: TraceSummary[] = [
      {
        ...base,
        traceId: "trace-ok",
        state: "completed",
        outcome: {
          terminalReason: "request-completed",
          failureStage: null,
          errorCode: null,
          retryable: null,
        },
        invocations: [
          {
            invocationId: "i1",
            traceId: "trace-ok",
            agentId: "codex",
            state: "completed",
            parentInvocationId: null,
            triggerMessageId: null,
            triggerType: "user-message",
            startedAt: base.startedAt,
            endedAt: base.endedAt,
            exitCode: 0,
            signal: null,
            outcome: {
              terminalReason: "assistant-final",
              failureStage: null,
              errorCode: null,
              retryable: null,
            },
          },
        ],
      },
      {
        ...base,
        traceId: "trace-failed",
        state: "failed",
        requestAttempt: 2,
        outcome: {
          terminalReason: "request-error",
          failureStage: "provider_run",
          errorCode: "provider_exit_7",
          retryable: false,
        },
        invocationCounts: { total: 1, failed: 1 },
        invocations: [
          {
            invocationId: "i2",
            traceId: "trace-failed",
            agentId: "grok",
            state: "failed",
            parentInvocationId: null,
            triggerMessageId: null,
            triggerType: "user-message",
            startedAt: base.startedAt,
            endedAt: base.endedAt,
            exitCode: 7,
            signal: null,
            outcome: {
              terminalReason: "provider-failed",
              failureStage: "provider_run",
              errorCode: "provider_exit_7",
              retryable: false,
            },
          },
        ],
      },
    ];
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TraceExplorer
          traces={traces}
          agents={[
            { id: "codex", label: "Codex" },
            { id: "grok", label: "Grok" },
          ]}
        />
      </QueryClientProvider>
    );
    expect(await screen.findByText("Handoff 调度")).toBeInTheDocument();
    expect(await screen.findByText("事故队列")).toBeInTheDocument();
    expect(screen.getByText("执行区段缺少结束事件")).toBeInTheDocument();
    expect(screen.getByText("需标注集")).toBeInTheDocument();
    expect(screen.getByText("-25pp")).toBeInTheDocument();
    expect(screen.getByText("样本不足")).toBeInTheDocument();
    expect(screen.getAllByText(/1\/2 · pending 1/).length).toBeGreaterThan(0);
    expect(screen.getByText("Codex")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /失败/ }));
    expect(screen.getByText("provider_exit_7")).toBeInTheDocument();
    expect(screen.getByText("Grok")).toBeInTheDocument();
  });
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TraceExplorer } from "./TraceExplorer";
import type { TraceSummary } from "./types";

const rate = (numerator: number, denominator: number) => ({
  value: denominator ? numerator / denominator : null,
  numerator,
  denominator,
  pending: 0,
  censored: 0,
  unknown: 0,
  excluded: 0,
});

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
        if (url.includes("/api/sessions/") && url.includes("/traces")) {
          return Promise.resolve(new Response(JSON.stringify({ traces, page: { total: 2 } })));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              metrics: {
                window: { from: base.startedAt, to: base.endedAt },
                scope: { kind: "thread", threadId: "s1" },
                handoff: {
                  completion: {
                    value: 0.5,
                    numerator: 1,
                    denominator: 2,
                    pending: 1,
                    censored: 0,
                    unknown: 0,
                    excluded: 0,
                  },
                  funnel: {
                    attempted: 3,
                    accepted: 2,
                    enqueued: 2,
                    started: 1,
                    completed: 1,
                    losses: {
                      duplicate: 1,
                      alreadyCompleted: 0,
                      rejected: 0,
                      notEnqueued: 0,
                      notStarted: 0,
                      executionFailed: 1,
                      aborted: 0,
                    },
                  },
                },
                memory: {
                  search: {
                    availabilityRate: rate(2, 2),
                    memoryHitRate: rate(1, 2),
                    totalResultRate: rate(2, 2),
                    averageMemoryHits: 0.5,
                    availability: { available: 2, degraded: 0, unavailable: 0, unknown: 0 },
                  },
                  injection: {
                    availabilityRate: rate(2, 2),
                    coverageRate: rate(1, 2),
                    averageDelivered: 0.5,
                    budgetDropRate: rate(0, 1),
                    truncationRate: rate(0, 2),
                    availability: { available: 2, degraded: 0, unavailable: 0, unknown: 0 },
                  },
                  write: { calls: 1, created: 1, unchanged: 0, superseded: 0, rejected: 0 },
                  strictRecallAtK: null,
                  usedRate: null,
                  correctRate: null,
                  businessSuccessRate: null,
                  completeness: "best_effort",
                  telemetry: { failed: 0, lastFailureAt: null, lastError: null },
                  applicability: { contractAppliedAt: base.startedAt, historicalExcluded: 0 },
                  semantics: "separate online metrics",
                },
                comparison: {
                  baselineWindow: { from: base.startedAt, to: base.endedAt },
                  minSamples: 5,
                  dropThreshold: 0.1,
                  indicators: [
                    {
                      metric: "handoff.completion",
                      state: "regressed",
                      delta: -0.25,
                      current: { value: 0.5, numerator: 1, denominator: 2 },
                      baseline: { value: 0.75, numerator: 3, denominator: 4 },
                    },
                    {
                      metric: "memory.searchHitRate",
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
          sessionId="s1"
          agents={[
            { id: "codex", label: "Codex" },
            { id: "grok", label: "Grok" },
          ]}
        />
      </QueryClientProvider>
    );
    expect(await screen.findByText("Handoff 完成")).toBeInTheDocument();
    expect(await screen.findByText("系统健康")).toBeInTheDocument();
    expect(screen.getByText("Handoff 证据轨道")).toBeInTheDocument();
    expect(screen.getByText("Memory 漏斗诊断")).toBeInTheDocument();
    expect(screen.getByText("未变化")).toBeInTheDocument();
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

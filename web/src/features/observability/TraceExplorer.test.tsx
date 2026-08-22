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
  request: {
    messageId: "message-user-1",
    turnNumber: 1,
    preview: "构建审计工作台",
    createdAt: "2026-08-13T00:00:00.000Z",
  },
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
        if (/\/api\/sessions\/s1\/traces\/[^?]+/.test(url)) {
          const traceId = new URL(url, "http://shift.local").pathname.split("/").at(-1);
          return Promise.resolve(
            new Response(
              JSON.stringify({ trace: traces.find((trace) => trace.traceId === traceId) })
            )
          );
        }
        if (url.includes("/api/sessions/") && url.includes("/traces")) {
          return Promise.resolve(new Response(JSON.stringify({ traces, page: { total: 3 } })));
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
                  applicability: {
                    contractAppliedAt: base.startedAt,
                    historicalEventsExcluded: 0,
                  },
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
        traceId: "trace-branched",
        state: "completed",
        request: {
          ...base.request,
          messageId: "message-user-2",
          turnNumber: 2,
          preview: "并行检查两个实现分支",
        },
        invocationCounts: { total: 3, failed: 0 },
        outcome: {
          terminalReason: "request-completed",
          failureStage: null,
          errorCode: null,
          retryable: null,
        },
        invocations: [
          {
            invocationId: "root",
            traceId: "trace-branched",
            agentId: "codex",
            state: "completed",
            parentInvocationId: null,
            triggerMessageId: "message-user-2",
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
          {
            invocationId: "branch-b",
            traceId: "trace-branched",
            agentId: "grok",
            state: "completed",
            parentInvocationId: "root",
            triggerMessageId: null,
            triggerType: "handoff",
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
          {
            invocationId: "branch-a",
            traceId: "trace-branched",
            agentId: "codex",
            state: "completed",
            parentInvocationId: "root",
            triggerMessageId: null,
            triggerType: "handoff",
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
        spans: [
          {
            spanId: "tool:i2:failed-tool",
            invocationId: "i2",
            parentSpanId: "generation:i2",
            kind: "tool",
            name: "failed-tool",
            state: "failed",
            complete: true,
            startedAt: base.startedAt,
            endedAt: base.endedAt,
            attributes: { toolId: "failed-tool", status: "failed" },
          },
          {
            spanId: "tool:i2:orphan-tool",
            invocationId: "i2",
            parentSpanId: "generation:i2",
            kind: "tool",
            name: "orphan-tool",
            state: "orphaned",
            complete: false,
            startedAt: null,
            endedAt: base.endedAt,
            attributes: { toolId: "orphan-tool", orphanFinish: true },
          },
          {
            spanId: "recall:1",
            invocationId: "i2",
            parentSpanId: "generation:i2",
            kind: "recall",
            name: "memory_searched",
            state: "completed",
            complete: true,
            startedAt: base.startedAt,
            endedAt: base.startedAt,
            attributes: {
              totalHits: 3,
              memoryHits: 2,
              delivered: 0,
              availability: "available",
              requestedLayers: ["memory", "message"],
            },
          },
          {
            spanId: "recall:2",
            invocationId: "i2",
            parentSpanId: "generation:i2",
            kind: "recall",
            name: "memory_injected",
            state: "completed",
            complete: true,
            startedAt: base.startedAt,
            endedAt: base.startedAt,
            attributes: {
              totalHits: 0,
              memoryHits: 0,
              delivered: 2,
              availability: "available",
              requestedLayers: [],
            },
          },
        ],
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
    expect(screen.getAllByText("provider_exit_7")).toHaveLength(2);
    expect(screen.getByText("Grok")).toBeInTheDocument();
    expect(screen.getByText("工具执行")).toBeInTheDocument();
    expect(screen.getByText(/2 次调用 · 1 失败 · 1 孤儿 · 1 未闭合/)).toBeInTheDocument();
    expect(screen.getByText("Memory 检索 / 注入")).toBeInTheDocument();
    expect(screen.getByText("1 次检索 · 1 次注入")).toBeInTheDocument();
    expect(screen.getByText("命中 3（Memory 2）")).toBeInTheDocument();
    expect(screen.getByText("delivered 2")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /并行检查两个实现分支/ }));
    expect(screen.getByRole("list", { name: "Agent 父子执行树" })).toBeInTheDocument();
    expect(screen.getAllByText("子调用 · 深度 1")).toHaveLength(2);
  });
});

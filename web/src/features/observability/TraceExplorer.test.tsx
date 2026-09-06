import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TraceExplorer } from "./TraceExplorer";
import type { ExecutionHandoff, ExecutionInvocation, TraceSpan, TraceSummary } from "./types";

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
              source: "bootstrap",
              availability: "available",
              requestedLayers: [],
            },
          },
          {
            spanId: "recall:3",
            invocationId: "i2",
            parentSpanId: "generation:i2",
            kind: "recall",
            name: "memory_write_completed",
            state: "completed",
            complete: true,
            startedAt: base.startedAt,
            endedAt: base.startedAt,
            attributes: { outcome: "created", topic: "storage" },
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
    expect(await screen.findByRole("button", { name: /系统告警/ })).toBeInTheDocument();
    expect(screen.queryByText("执行区段缺少结束事件")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /系统告警/ }));
    expect(screen.getByText("执行区段缺少结束事件")).toBeInTheDocument();
    expect(screen.queryByText("Handoff 证据轨道")).not.toBeInTheDocument();
    expect(screen.queryByText("Memory 漏斗诊断")).not.toBeInTheDocument();
    expect(screen.getAllByText("Codex").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: /失败/ }));
    expect(screen.getAllByText("provider_exit_7").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Grok").length).toBeGreaterThan(0);
    expect(screen.getByText("执行时间轴")).toBeInTheDocument();
    expect(screen.getByText("1 Invocation · 0 Handoff")).toBeInTheDocument();
    expect(screen.getByText("执行 1 失败 · 交接无失败 · 工具 1 失败 · 1 孤儿")).toBeInTheDocument();
    expect(screen.queryByText("无失败")).not.toBeInTheDocument();
    expect(screen.getByText("工具执行")).toBeInTheDocument();
    expect(screen.getByText(/2 次调用 · 1 失败 · 1 孤儿 · 1 未闭合/)).toBeInTheDocument();
    expect(screen.queryByText("Memory 检索")).not.toBeInTheDocument();
    expect(screen.queryByText("0ms")).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "启动注入 2 条 · 检索命中 2 条 · 写入 1 条" })
    );
    expect(screen.getAllByText("Memory 检索").length).toBeGreaterThan(0);
    expect(screen.getByText("命中 3（Memory 2）")).toBeInTheDocument();
    expect(screen.getByText("启动注入")).toBeInTheDocument();
    expect(screen.getByText("送达 2")).toBeInTheDocument();
    expect(screen.getByText("Memory 写入")).toBeInTheDocument();
    expect(screen.getByText("已创建 · storage")).toBeInTheDocument();
    expect(screen.queryByText("0ms")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "展开 2 条失败或未闭合" }));
    expect(screen.getByText("failed-tool")).toBeInTheDocument();
    expect(screen.getByText("orphan-tool")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /并行检查两个实现分支/ }));
    expect(screen.getByText("3 Invocation · 0 Handoff")).toBeInTheDocument();
    expect(screen.getByText("执行完成 · 交接无失败")).toBeInTheDocument();
    expect(screen.getByText("2 个 Agent · 0 次交接")).toBeInTheDocument();
    expect(screen.queryByText("Codex → Grok → Codex")).not.toBeInTheDocument();
    expect(screen.getAllByText("handoff").length).toBe(2);
  });

  it("places every handoff before its target and keeps fan-out hops", async () => {
    const traces: TraceSummary[] = [
      {
        ...base,
        traceId: "trace-linear",
        state: "completed",
        request: { ...base.request, turnNumber: 5, preview: "多 Agent 协作" },
        invocationCounts: { total: 7, failed: 0 },
        handoffCounts: { total: 6, accepted: 6, failed: 0 },
        outcome: {
          terminalReason: "request-completed",
          failureStage: null,
          errorCode: null,
          retryable: null,
        },
        invocations: [
          testInvocation("i1", "codex", "user-message"),
          testInvocation("i2", "grok"),
          testInvocation("i3", "codex"),
          testInvocation("i4", "grok"),
          testInvocation("i5", "codex"),
          testInvocation("i6", "grok"),
          testInvocation("i7", "codex"),
        ],
        handoffs: [
          testHandoff("h1", "i1", "i2", "codex", "grok"),
          testHandoff("h2", "i2", "i3", "grok", "codex"),
          testHandoff("h3", "i3", "i4", "codex", "grok"),
          testHandoff("h4", "i4", "i5", "grok", "codex"),
          testHandoff("h5", "i5", "i6", "codex", "grok"),
          testHandoff("h6", "i6", "i7", "grok", "codex"),
        ],
        spans: [
          testRecall("i1", "memory_injected", { source: "bootstrap", delivered: 2 }),
          testRecall("i1", "memory_write_completed", { outcome: "created", topic: "storage" }),
          testRecall("i2", "memory_injected", { source: "a2a", delivered: 2, selected: 3 }),
          testRecall("i2", "memory_searched", { memoryHits: 3, totalHits: 4 }),
        ],
      },
      {
        ...base,
        traceId: "trace-fanout",
        state: "completed",
        request: { ...base.request, turnNumber: 6, preview: "同一来源两条交接" },
        invocationCounts: { total: 3, failed: 0 },
        handoffCounts: { total: 3, accepted: 2, failed: 1 },
        outcome: {
          terminalReason: "request-completed",
          failureStage: null,
          errorCode: null,
          retryable: null,
        },
        invocations: [
          testInvocation("root", "codex", "user-message"),
          testInvocation("branch-b", "grok"),
          testInvocation("branch-a", "codex"),
        ],
        handoffs: [
          testHandoff("hf1", "root", "branch-b", "codex", "grok"),
          testHandoff("hf2", "root", "branch-a", "codex", "codex"),
          {
            ...testHandoff("hf3", "branch-a", "missing", "codex", "grok"),
            targetInvocationId: null,
            completeStatus: "failed",
          },
        ],
      },
      {
        ...base,
        traceId: "trace-active",
        state: "active",
        endedAt: null,
        request: { ...base.request, turnNumber: 7, preview: "仍在执行" },
        invocationCounts: { total: 1, failed: 0 },
        outcome: {
          terminalReason: null,
          failureStage: null,
          errorCode: null,
          retryable: null,
        },
        invocations: [
          {
            ...testInvocation("live", "codex", "user-message"),
            state: "active",
            endedAt: null,
          },
        ],
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/api/storage/health")) {
          return Promise.resolve(
            new Response(JSON.stringify({ storage: { observability: { alerts: [] } } }))
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
          return Promise.resolve(
            new Response(JSON.stringify({ traces, page: { total: traces.length } }))
          );
        }
        return Promise.resolve(new Response(JSON.stringify({})));
      })
    );
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

    expect(await screen.findByText("7 Invocation · 6 Handoff")).toBeInTheDocument();
    expect(screen.getByText("执行完成 · 交接无失败")).toBeInTheDocument();
    expect(screen.getByText("2 个 Agent · 6 次交接")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "启动注入 2 条 · 写入 1 条" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "交接注入 2 条 · 检索命中 3 条" })
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "交接注入 2 条 · 检索命中 3 条" }));
    expect(screen.getByText("交接注入")).toBeInTheDocument();
    expect(screen.getByText("送达 2 / 选中 3")).toBeInTheDocument();
    expect(timelineSequence()).toEqual([
      "Codex",
      "Codex → Grok",
      "Grok",
      "Grok → Codex",
      "Codex",
      "Codex → Grok",
      "Grok",
      "Grok → Codex",
      "Codex",
      "Codex → Grok",
      "Grok",
      "Grok → Codex",
      "Codex",
    ]);

    await userEvent.click(screen.getByRole("button", { name: /同一来源两条交接/ }));
    expect(screen.getByText("3 Invocation · 3 Handoff")).toBeInTheDocument();
    expect(screen.getByText("执行完成 · 交接 1 失败")).toBeInTheDocument();
    expect(timelineSequence()).toEqual([
      "Codex",
      "Codex → Grok",
      "Grok",
      "Codex → Codex",
      "Codex",
      "Codex → Grok",
    ]);

    await userEvent.click(screen.getByRole("button", { name: /仍在执行/ }));
    expect(screen.getAllByText("进行中").length).toBeGreaterThan(0);
    expect(document.querySelector(".trace-waterfall-track i[data-open='true']")).not.toBeNull();
    expect(screen.getByTitle("未结束")).toBeInTheDocument();
  });
});

function testInvocation(
  invocationId: string,
  agentId: string,
  triggerType = "handoff"
): ExecutionInvocation {
  return {
    invocationId,
    traceId: "trace-linear",
    agentId,
    state: "completed",
    parentInvocationId: null,
    triggerMessageId: null,
    triggerType,
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
  };
}

function testHandoff(
  handoffId: string,
  sourceInvocationId: string,
  targetInvocationId: string,
  sourceAgent: string,
  targetAgent: string
): ExecutionHandoff {
  return {
    handoffId,
    sourceInvocationId,
    targetInvocationId,
    sourceAgent,
    targetAgent,
    routeStatus: "accepted",
    receiveStatus: "started",
    completeStatus: "completed",
    reason: "handoff",
    depth: 1,
    duplicateOf: null,
    repairOf: null,
    phaseId: null,
    policy: null,
    createdAt: base.startedAt,
    enqueuedAt: base.startedAt,
    startedAt: base.startedAt,
    completedAt: base.endedAt,
    outcome: {
      terminalReason: "handoff-completed",
      failureStage: null,
      errorCode: null,
      retryable: null,
    },
  };
}

function testRecall(
  invocationId: string,
  name: TraceSpan["name"],
  attributes: TraceSpan["attributes"]
): TraceSpan {
  return {
    spanId: `recall:${invocationId}:${name}`,
    invocationId,
    parentSpanId: `generation:${invocationId}`,
    kind: "recall",
    name,
    state: "completed",
    complete: true,
    startedAt: base.startedAt,
    endedAt: base.startedAt,
    attributes,
  };
}

function timelineSequence() {
  const timeline = document.querySelector(".trace-waterfall");
  return [
    ...(timeline?.querySelectorAll(
      ".trace-waterfall-hop, .trace-waterfall-row[data-kind='generation']"
    ) || []),
  ].map((node) => {
    if (node.classList.contains("trace-waterfall-hop")) {
      return node.querySelector("span")?.textContent?.replace(/\s+/g, " ").trim() || "";
    }
    return node.querySelector("strong")?.textContent || "";
  });
}

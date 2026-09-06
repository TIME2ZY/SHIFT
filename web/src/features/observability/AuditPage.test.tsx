import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { AuditPage } from "./AuditPage";

vi.mock("./TraceExplorer", () => ({
  TraceExplorer: () => <div>Trace 工作台</div>,
}));

vi.mock("./queries", () => ({
  useSessionTracesQuery: () => ({ data: { traces: [] }, isPending: false, error: null }),
  useSessionAuditSummaryQuery: () => ({
    data: {
      session: {
        id: "session-1",
        title: "审计测试",
        projectKey: "project-1",
        projectDir: "C:/project",
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:01:00.000Z",
      },
      volume: { userTurns: 2, messages: 5, traces: 1, invocations: 2 },
      execution: {
        traces: { active: 0, completed: 1, failed: 0, aborted: 0 },
        invocations: { active: 0, completed: 2, failed: 0, aborted: 0 },
        retries: 0,
        terminalDurationMs: 62000,
        firstStartedAt: "2026-08-20T00:00:00.000Z",
        lastActivityAt: "2026-08-20T00:01:02.000Z",
        latestTrace: {
          traceId: "trace-1",
          state: "completed",
          terminalReason: "assistant-final",
          failureStage: null,
          errorCode: null,
          startedAt: "2026-08-20T00:00:00.000Z",
          endedAt: "2026-08-20T00:01:02.000Z",
        },
      },
      collaboration: {
        agentIds: ["codex"],
        handoffs: 1,
        acceptedHandoffs: 1,
        maxHandoffDepth: 1,
      },
      tools: { calls: 2, completed: 2, failed: 0, incomplete: 0, orphanFinishes: 0 },
      memory: {
        searches: 5,
        searchHits: 4,
        averageMemoryHits: 1.6,
        injections: 15,
        injectionsDelivered: 13,
        truncatedInjections: 3,
        writes: 7,
        writeCreated: 5,
        writeUnchanged: 0,
        writeSuperseded: 2,
        writeRejected: 0,
        active: 1,
      },
      usage: { available: true, session: { totalTokens: 1200, costUsd: 0.12 }, agents: [] },
    },
    isPending: false,
    error: null,
  }),
}));

vi.mock("../memory/queries", () => ({
  useMemoriesQuery: () => ({
    data: {
      memories: [
        {
          id: "memory-1",
          kind: "decision",
          topic: "存储",
          content: "SQLite 是唯一真相源。",
          createdAt: "2026-08-20T00:00:00.000Z",
          sourceInvocationId: "invocation-source-1",
          sourceMessageId: "message-source-1",
          createdBy: "codex",
          metadata: { evidenceKind: "assistant-output" },
          anchors: [{ messageId: "message-source-1" }],
        },
      ],
    },
    isPending: false,
    error: null,
  }),
  useMemoryUsageQuery: () => ({
    data: { "memory-1": { searched: 2, injected: 1 } },
    isPending: false,
    error: null,
  }),
}));

describe("AuditPage", () => {
  it("places trace metrics and read-only Memory in the main audit workspace", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AuditPage
          sessionId="session-1"
          sessionTitle="审计测试"
          agents={[{ id: "codex", label: "Codex" }]}
          onOpenChat={() => undefined}
          onOpenSessions={() => undefined}
          sessionTriggerRef={createRef<HTMLButtonElement>()}
        />
      </QueryClientProvider>
    );

    expect(screen.getByText("审计测试")).toBeInTheDocument();
    expect(screen.getByText("Trace 工作台")).toBeInTheDocument();
    expect(screen.getByText("会话证据概览")).toBeInTheDocument();
    expect(screen.getByText("2 轮")).toBeInTheDocument();
    expect(screen.getByText("1 Trace")).toBeInTheDocument();
    expect(screen.getByText("4/5 检索命中")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "当前 Memory" })).toBeInTheDocument();
    expect(screen.getByText("存储")).toBeInTheDocument();
    expect(screen.getByText("检索 2 · 注入 1")).toBeInTheDocument();
    expect(screen.getByText(/不设人工审核状态/)).toBeInTheDocument();
  });

  it("discloses memory provenance only after expanding the card", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AuditPage
          sessionId="session-1"
          sessionTitle="审计测试"
          agents={[{ id: "codex", label: "Codex" }]}
          onOpenChat={() => undefined}
          onOpenSessions={() => undefined}
          sessionTriggerRef={createRef<HTMLButtonElement>()}
        />
      </QueryClientProvider>
    );

    expect(screen.queryByText("SQLite 是唯一真相源。")).not.toBeInTheDocument();
    expect(screen.queryByText("来源 Invocation")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /存储/ }));
    expect(screen.getByText("SQLite 是唯一真相源。")).toBeInTheDocument();
    expect(screen.getByText("来源 Invocation")).toBeInTheDocument();
    expect(screen.getByText("assistant-output")).toBeInTheDocument();
  });
});
